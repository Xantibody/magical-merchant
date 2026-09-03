import { describe, it, expect } from "vitest";
import { entryMeta } from "./timeline-meta";
import type { DeviceContext } from "./parse-timeline";

function context(overrides: Partial<DeviceContext> = {}): DeviceContext {
  return { os: "macos", arch: "aarch64", ...overrides };
}

describe("entryMeta", () => {
  it("names the platform with the icon of its form factor", () => {
    expect(entryMeta(context({ os: "macos" }))[0]).toStrictEqual({
      icon: "laptop",
      label: "macos",
    });
    expect(entryMeta(context({ os: "android" }))[0]).toStrictEqual({
      icon: "device-mobile",
      label: "android",
    });
  });

  it("appends the OS version when it is known", () => {
    expect(entryMeta(context({ os_version: "15.5" }))[0].label).toBe("macos 15.5");
  });

  it("tells wired from wireless", () => {
    expect(entryMeta(context({ network_type: "WiFi" }))[1]).toStrictEqual({
      icon: "wifi-high",
      label: "Wi-Fi",
    });
    expect(entryMeta(context({ network_type: "Ethernet" }))[1]).toStrictEqual({
      icon: "network",
      label: "有線",
    });
    expect(entryMeta(context({ network_type: "Mobile" }))[1]).toStrictEqual({
      icon: "cell-signal-full",
      label: "モバイル回線",
    });
    expect(entryMeta(context({ network_type: "Offline" }))[1]).toStrictEqual({
      icon: "wifi-slash",
      label: "オフライン",
    });
  });

  it("shows the battery level with an icon that matches it", () => {
    expect(entryMeta(context({ battery: 68 }))[1]).toStrictEqual({
      icon: "battery-high",
      label: "68%",
    });
    expect(entryMeta(context({ battery: 68, is_charging: true }))[1]).toStrictEqual({
      icon: "battery-charging",
      label: "68%",
    });
  });

  it("names the place when the coordinate has been resolved", () => {
    const meta = entryMeta(
      context({ location: { latitude: 35.6761403, longitude: 139.5465634 } }),
      () => "渋谷区",
    );

    expect(meta[1]).toStrictEqual({ icon: "map-pin", label: "渋谷区" });
  });

  it("shows where the entry was written", () => {
    expect(
      entryMeta(context({ location: { latitude: 35.6761403, longitude: 139.5465634 } }))[1],
    ).toStrictEqual({ icon: "map-pin", label: "35.6761, 139.5466" });
  });

  it("keeps the sign of the southern and western hemispheres", () => {
    expect(
      entryMeta(context({ location: { latitude: -33.8688, longitude: -70.6693 } }))[1].label,
    ).toBe("-33.8688, -70.6693");
  });

  it("leaves out what was not recorded", () => {
    expect(entryMeta(context())).toStrictEqual([{ icon: "laptop", label: "macos" }]);
  });

  it("keeps the order device, location, network, battery", () => {
    const meta = entryMeta(
      context({
        os: "android",
        location: { latitude: 35.6761403, longitude: 139.5465634 },
        network_type: "Mobile",
        battery: 30,
      }),
    ).map((s) => s.label);

    expect(meta).toStrictEqual(["android", "35.6761, 139.5466", "モバイル回線", "30%"]);
  });

  it("says nothing at all when there is no context", () => {
    expect(entryMeta(null)).toStrictEqual([]);
  });

  it("skips the device when the platform is unknown", () => {
    expect(entryMeta({ os: "", arch: "", battery: 50 })).toStrictEqual([
      { icon: "battery-high", label: "50%" },
    ]);
  });
});
