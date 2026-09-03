import type { IconName } from "../components/Icon";
import { t } from "./i18n";

export interface DeviceContext {
  battery?: number;
  is_charging?: boolean;
  network_type?: "WiFi" | "Ethernet" | "Mobile" | "Offline";
  location?: { latitude: number; longitude: number };
  os: string;
  os_version?: string;
  arch: string;
  hostname?: string;
  locale?: string;
  /**
   * どの入り口で書かれたか(`app` / `cli` / `mcp` / `widget`)。行末 JSON では
   * 1 文字のキー — エントリ 1 行あたり数十文字の本文に対して、`"source"` と
   * 綴ると読める Markdown ではなくなる。名乗る前に書かれた行には無い。
   */
  s?: string;
}

export interface ParsedEntry {
  time: string;
  text: string;
  context: DeviceContext | null;
}

export function parseTimelineEntry(raw: string): ParsedEntry {
  const timeMatch = raw.match(/^- \[(?<time>\d{2}:\d{2}:\d{2})\] /u);
  if (!timeMatch) {
    return { time: "", text: raw, context: null };
  }

  const time = timeMatch.groups?.time ?? "";
  const rest = raw.slice(timeMatch[0].length);

  const lastBrace = rest.lastIndexOf(" {");
  if (lastBrace !== -1) {
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
  if (ctx.battery === undefined) {
    return null;
  }
  if (ctx.is_charging) {
    return "battery-charging";
  }
  if (ctx.battery >= 75) {
    return "battery-full";
  }
  if (ctx.battery >= 50) {
    return "battery-high";
  }
  if (ctx.battery >= 25) {
    return "battery-medium";
  }
  if (ctx.battery >= 5) {
    return "battery-low";
  }
  return "battery-empty";
}

export function getNetworkIcon(ctx: DeviceContext): IconName | null {
  if (!ctx.network_type) {
    return null;
  }
  switch (ctx.network_type) {
    case "WiFi": {
      return "wifi-high";
    }
    case "Ethernet": {
      return "network";
    }
    case "Mobile": {
      return "cell-signal-full";
    }
    case "Offline": {
      return "wifi-slash";
    }
    default: {
      return null;
    }
  }
}

/**
 * 回線の呼び名。記録に残っているのは `WiFi` のような素の値で、これは
 * 読むための言い換え。タイムラインの行にもメタデータパネルにも出る。
 */
export function networkLabel(type: string): string {
  const labels = t().meta;
  switch (type) {
    case "WiFi": {
      return labels.wifi;
    }
    case "Ethernet": {
      return labels.ethernet;
    }
    case "Mobile": {
      return labels.mobile;
    }
    case "Offline": {
      return labels.offline;
    }
    default: {
      return type;
    }
  }
}

/**
 * 書いたツールの呼び名。記録に残っているのは `widget` のような素の値で、
 * これは読むための言い換え。知らない値はそのまま出す — 語彙が増えた版で
 * 書いた記録を、古い版が「不明」に潰してはいけない。
 */
export function sourceLabel(source: string): string {
  const labels = t().meta;
  switch (source) {
    case "app": {
      return labels.sourceApp;
    }
    case "cli": {
      return labels.sourceCli;
    }
    case "mcp": {
      return labels.sourceMcp;
    }
    case "widget": {
      return labels.sourceWidget;
    }
    default: {
      return source;
    }
  }
}

export function getOsLabel(ctx: DeviceContext): string | null {
  if (!ctx.os) {
    return null;
  }
  const parts: string[] = [ctx.os];
  if (ctx.os_version) {
    parts.push(ctx.os_version);
  }
  if (ctx.arch) {
    parts.push(ctx.arch);
  }
  return parts.join(" ");
}
