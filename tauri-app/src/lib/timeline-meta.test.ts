import { describe, it, expect } from "vitest";
import { entryMeta } from "./timeline-meta";
import type { DeviceContext } from "./parse-timeline";

function context(overrides: Partial<DeviceContext> = {}): DeviceContext {
  return { os: "macos", arch: "aarch64", ...overrides };
}

describe("entryMeta", () => {
  it("names the platform with the icon of its form factor", () => {
    expect(entryMeta(context({ os: "macos" }))[0]).toEqual({ icon: "laptop", label: "macos" });
    expect(entryMeta(context({ os: "android" }))[0]).toEqual({
      icon: "device-mobile",
      label: "android",
    });
  });

  it("appends the OS version when it is known", () => {
    expect(entryMeta(context({ os_version: "15.5" }))[0].label).toBe("macos 15.5");
  });

  it("prefers the network name over its type", () => {
    const meta = entryMeta(context({ network_type: "WiFi", wifi_ssid: "オフィスWi-Fi" }));

    expect(meta[1]).toEqual({ icon: "wifi-high", label: "オフィスWi-Fi" });
  });

  // SSID は macOS の伏字対策で落ちることがある。Wi-Fi だと分かる以上は出す。
  it("falls back to the network type when the name is unavailable", () => {
    expect(entryMeta(context({ network_type: "WiFi" }))[1]).toEqual({
      icon: "wifi-high",
      label: "Wi-Fi",
    });
    expect(entryMeta(context({ network_type: "Mobile" }))[1]).toEqual({
      icon: "cell-signal-full",
      label: "モバイル回線",
    });
    expect(entryMeta(context({ network_type: "Offline" }))[1]).toEqual({
      icon: "wifi-slash",
      label: "オフライン",
    });
  });

  it("shows the battery level with an icon that matches it", () => {
    expect(entryMeta(context({ battery: 68 }))[1]).toEqual({
      icon: "battery-high",
      label: "68%",
    });
    expect(entryMeta(context({ battery: 68, is_charging: true }))[1]).toEqual({
      icon: "battery-charging",
      label: "68%",
    });
  });

  it("leaves out what was not recorded", () => {
    expect(entryMeta(context())).toEqual([{ icon: "laptop", label: "macos" }]);
  });

  it("keeps the order device, network, battery", () => {
    const meta = entryMeta(context({ os: "android", network_type: "Mobile", battery: 30 })).map(
      (s) => s.label,
    );

    expect(meta).toEqual(["android", "モバイル回線", "30%"]);
  });

  it("says nothing at all when there is no context", () => {
    expect(entryMeta(null)).toEqual([]);
  });

  it("skips the device when the platform is unknown", () => {
    expect(entryMeta({ os: "", arch: "", battery: 50 })).toEqual([
      { icon: "battery-high", label: "50%" },
    ]);
  });
});
