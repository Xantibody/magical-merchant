import type { IconName } from "../components/Icon";
import { getBatteryIcon, getNetworkIcon } from "./parse-timeline";
import type { DeviceContext } from "./parse-timeline";

/** エントリ本文の下に並べる、記録時の状況ひとつ。 */
export interface MetaSegment {
  icon: IconName;
  label: string;
}

const NETWORK_LABELS = {
  WiFi: "Wi-Fi",
  Mobile: "モバイル回線",
  Offline: "オフライン",
} as const;

function deviceSegment(ctx: DeviceContext): MetaSegment | null {
  if (!ctx.os) {
    return null;
  }
  return {
    icon: ctx.os === "android" ? "device-mobile" : "laptop",
    label: ctx.os_version ? `${ctx.os} ${ctx.os_version}` : ctx.os,
  };
}

function networkSegment(ctx: DeviceContext): MetaSegment | null {
  const icon = getNetworkIcon(ctx);
  if (!icon || !ctx.network_type) {
    return null;
  }
  // SSID が分かるならそちらを出す。「Wi-Fi」より「自宅」のほうが、
  // どこで書いたのかを思い出す手がかりになる。
  return { icon, label: ctx.wifi_ssid ?? NETWORK_LABELS[ctx.network_type] };
}

function batterySegment(ctx: DeviceContext): MetaSegment | null {
  const icon = getBatteryIcon(ctx);
  return icon ? { icon, label: `${ctx.battery}%` } : null;
}

/** 記録できていたものだけを、端末 → 回線 → 電源の順に並べる。 */
export function entryMeta(context: DeviceContext | null): MetaSegment[] {
  if (!context) {
    return [];
  }
  return [deviceSegment(context), networkSegment(context), batterySegment(context)].filter(
    (segment): segment is MetaSegment => segment !== null,
  );
}
