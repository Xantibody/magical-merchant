import type { IconName } from "../components/Icon";

export interface DeviceContext {
  battery?: number;
  is_charging?: boolean;
  network_type?: "WiFi" | "Mobile" | "Offline";
  wifi_ssid?: string;
  location?: { latitude: number; longitude: number };
  os: string;
  os_version?: string;
  arch: string;
  hostname?: string;
  locale?: string;
}

export interface ParsedEntry {
  time: string;
  text: string;
  context: DeviceContext | null;
}

export function parseTimelineEntry(raw: string): ParsedEntry {
  // Match timestamp prefix: "- [HH:MM:SS] ..."
  const timeMatch = raw.match(/^- \[(\d{2}:\d{2}:\d{2})\] /);
  if (!timeMatch) {
    return { time: "", text: raw, context: null };
  }

  const time = timeMatch[1];
  const rest = raw.slice(timeMatch[0].length);

  // Try to extract context JSON from the last " {" in the line
  const lastBrace = rest.lastIndexOf(" {");
  if (lastBrace >= 0) {
    const jsonCandidate = rest.slice(lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonCandidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const context = Object.keys(parsed).length > 0 ? (parsed as DeviceContext) : null;
        return { time, text: rest.slice(0, lastBrace), context };
      }
    } catch {
      // Not valid JSON, treat entire rest as text
    }
  }

  return { time, text: rest, context: null };
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
