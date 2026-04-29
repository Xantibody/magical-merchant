import { describe, it, expect } from "vitest";
import {
  parseTimelineEntry,
  getBatteryIcon,
  getNetworkIcon,
  getOsLabel,
  hasLocation,
} from "./parse-timeline";

describe("parseTimelineEntry", () => {
  it("parses entry with context JSON", () => {
    const raw = '- [14:30:45] hello world {"battery":82,"is_charging":false}';
    const result = parseTimelineEntry(raw);
    expect(result.time).toBe("14:30:45");
    expect(result.text).toBe("hello world");
    expect(result.context).toEqual({ battery: 82, is_charging: false });
  });

  it("parses entry without context (old format)", () => {
    const raw = "- [14:30:45] hello world";
    const result = parseTimelineEntry(raw);
    expect(result.time).toBe("14:30:45");
    expect(result.text).toBe("hello world");
    expect(result.context).toBeNull();
  });

  it("handles text containing braces", () => {
    const raw = '- [14:30:45] code {foo} {"battery":50}';
    const result = parseTimelineEntry(raw);
    expect(result.time).toBe("14:30:45");
    expect(result.text).toBe("code {foo}");
    expect(result.context).toEqual({ battery: 50 });
  });

  it("normalizes empty object {} to null", () => {
    const raw = "- [14:30:45] text {}";
    const result = parseTimelineEntry(raw);
    expect(result.time).toBe("14:30:45");
    expect(result.text).toBe("text");
    expect(result.context).toBeNull();
  });

  it("treats invalid JSON as part of text", () => {
    const raw = "- [14:30:45] text {invalid";
    const result = parseTimelineEntry(raw);
    expect(result.time).toBe("14:30:45");
    expect(result.text).toBe("text {invalid");
    expect(result.context).toBeNull();
  });

  it("returns raw text for non-matching format", () => {
    const raw = "just some text";
    const result = parseTimelineEntry(raw);
    expect(result.time).toBe("");
    expect(result.text).toBe("just some text");
    expect(result.context).toBeNull();
  });
});

describe("getBatteryIcon", () => {
  const ctx = (battery: number, charging = false) =>
    ({ battery, is_charging: charging, os: "", arch: "" }) as const;

  it("returns battery-charging when charging", () => {
    expect(getBatteryIcon(ctx(50, true))).toBe("battery-charging");
  });

  it("returns battery-full for >= 75%", () => {
    expect(getBatteryIcon(ctx(75))).toBe("battery-full");
    expect(getBatteryIcon(ctx(100))).toBe("battery-full");
  });

  it("returns battery-high for 50-74%", () => {
    expect(getBatteryIcon(ctx(50))).toBe("battery-high");
    expect(getBatteryIcon(ctx(74))).toBe("battery-high");
  });

  it("returns battery-medium for 25-49%", () => {
    expect(getBatteryIcon(ctx(25))).toBe("battery-medium");
    expect(getBatteryIcon(ctx(49))).toBe("battery-medium");
  });

  it("returns battery-low for 5-24%", () => {
    expect(getBatteryIcon(ctx(5))).toBe("battery-low");
    expect(getBatteryIcon(ctx(24))).toBe("battery-low");
  });

  it("returns battery-empty for 0-4%", () => {
    expect(getBatteryIcon(ctx(0))).toBe("battery-empty");
    expect(getBatteryIcon(ctx(4))).toBe("battery-empty");
  });

  it("returns null when battery is undefined", () => {
    expect(getBatteryIcon({ os: "", arch: "" })).toBeNull();
  });
});

describe("getNetworkIcon", () => {
  it("returns wifi-high for WiFi", () => {
    expect(getNetworkIcon({ network_type: "WiFi", os: "", arch: "" })).toBe("wifi-high");
  });

  it("returns cell-signal-full for Mobile", () => {
    expect(getNetworkIcon({ network_type: "Mobile", os: "", arch: "" })).toBe("cell-signal-full");
  });

  it("returns wifi-slash for Offline", () => {
    expect(getNetworkIcon({ network_type: "Offline", os: "", arch: "" })).toBe("wifi-slash");
  });

  it("returns null when network_type is undefined", () => {
    expect(getNetworkIcon({ os: "", arch: "" })).toBeNull();
  });
});

describe("getOsLabel", () => {
  it("returns full label with all parts", () => {
    expect(getOsLabel({ os: "macos", os_version: "15.3", arch: "aarch64" })).toBe(
      "macos 15.3 aarch64",
    );
  });

  it("returns os + arch without version", () => {
    expect(getOsLabel({ os: "linux", arch: "x86_64" })).toBe("linux x86_64");
  });

  it("returns null when os is empty", () => {
    expect(getOsLabel({ os: "", arch: "" })).toBeNull();
  });
});

describe("hasLocation", () => {
  it("returns true when location exists", () => {
    expect(hasLocation({ os: "", arch: "", location: { latitude: 35, longitude: 139 } })).toBe(
      true,
    );
  });

  it("returns false when location is undefined", () => {
    expect(hasLocation({ os: "", arch: "" })).toBe(false);
  });
});
