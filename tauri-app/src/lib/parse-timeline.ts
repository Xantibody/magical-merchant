import type { IconName } from "../components/Icon";

export interface DeviceContext {
  battery?: number;
  is_charging?: boolean;
  network_type?: "WiFi" | "Mobile" | "Offline";
  wifi_ssid?: string;
  location?: { latitude: number; longitude: number };
  os?: string;
  os_version?: string;
  arch?: string;
  hostname?: string;
  locale?: string;
}

export interface ParsedEntry {
  time: string;
  text: string;
  context: DeviceContext | null;
}

export function parseTimelineEntry(raw: string): ParsedEntry {
  // Format: "- [HH:MM:SS] text {json}"
  const match = raw.match(/^- \[(\d{2}:\d{2}:\d{2})\] (.*?) (\{.*\})$/s);
  if (!match) {
    // Try without context JSON (old format or no context)
    const timeMatch = raw.match(/^- \[(\d{2}:\d{2}:\d{2})\] (.*)$/s);
    if (timeMatch) {
      return { time: timeMatch[1], text: timeMatch[2], context: null };
    }
    return { time: "", text: raw, context: null };
  }

  let context: DeviceContext | null = null;
  try {
    context = JSON.parse(match[3]);
  } catch {
    // Invalid JSON, treat as part of text
  }

  return {
    time: match[1],
    text: context ? match[2] : `${match[2]} ${match[3]}`,
    context,
  };
}

export function getBatteryIcon(ctx: DeviceContext): IconName | null {
  if (ctx.battery == null) return null;
  if (ctx.is_charging) return "battery-charging";
  if (ctx.battery >= 75) return "battery-full";
  if (ctx.battery >= 50) return "battery-high";
  if (ctx.battery >= 25) return "battery-medium";
  if (ctx.battery >= 5) return "battery-low";
  return "battery-empty";
}

export function getNetworkIcon(ctx: DeviceContext): IconName | null {
  if (!ctx.network_type) return null;
  switch (ctx.network_type) {
    case "WiFi":
      return "wifi-high";
    case "Mobile":
      return "cell-signal-full";
    case "Offline":
      return "wifi-slash";
    default:
      return null;
  }
}

export function hasLocation(ctx: DeviceContext): boolean {
  return ctx.location != null;
}

export function getOsLabel(ctx: DeviceContext): string | null {
  if (!ctx.os) return null;
  const parts: string[] = [ctx.os];
  if (ctx.os_version) parts.push(ctx.os_version);
  if (ctx.arch) parts.push(ctx.arch);
  return parts.join(" ");
}
