import { describe, it, expect } from "vitest";
import { parseAndroidVersion, toBatteryPercent, toNetworkType } from "./client-context";

describe("parseAndroidVersion", () => {
  it("reads the version out of an Android WebView user agent", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(parseAndroidVersion(ua)).toBe("14");
  });

  it("keeps the minor components", () => {
    expect(parseAndroidVersion("(Linux; Android 13.0.1; SM-S911B)")).toBe("13.0.1");
  });

  it("returns null on a desktop user agent", () => {
    expect(
      parseAndroidVersion("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    ).toBeNull();
  });
});

describe("toNetworkType", () => {
  it("reports Offline when the WebView says it is offline", () => {
    expect(toNetworkType(false, "wifi")).toBe("Offline");
  });

  it("maps the Network Information API values", () => {
    expect(toNetworkType(true, "wifi")).toBe("WiFi");
    expect(toNetworkType(true, "cellular")).toBe("Mobile");
  });

  it("reports Offline when the connection type says none", () => {
    expect(toNetworkType(true, "none")).toBe("Offline");
  });

  // 種別が分からないまま WiFi と決め打つと記録が嘘になる。
  it("returns null when the connection type is unknown or absent", () => {
    expect(toNetworkType(true)).toBeNull();
    expect(toNetworkType(true, "ethernet")).toBeNull();
  });
});

describe("toBatteryPercent", () => {
  it("turns the 0..1 level into a percentage", () => {
    expect(toBatteryPercent(0.82)).toBe(82);
    expect(toBatteryPercent(1)).toBe(100);
    expect(toBatteryPercent(0)).toBe(0);
  });

  it("rounds to the nearest whole percent", () => {
    expect(toBatteryPercent(0.555)).toBe(56);
  });

  it("clamps values outside the documented range", () => {
    expect(toBatteryPercent(1.5)).toBe(100);
    expect(toBatteryPercent(-0.2)).toBe(0);
  });
});
