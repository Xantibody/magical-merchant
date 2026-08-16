import type { IconName } from "../components/Icon";
import { getBatteryIcon, getNetworkIcon, networkLabel } from "./parse-timeline";
import type { DeviceContext } from "./parse-timeline";

/** エントリ本文の下に並べる、記録時の状況ひとつ。 */
export interface MetaSegment {
  icon: IconName;
  label: string;
}

/** 座標に付ける地名を引くもの。まだ引けていなければ undefined。 */
export type PlaceLookup = (location: { latitude: number; longitude: number }) => string | undefined;

function deviceSegment(ctx: DeviceContext): MetaSegment | null {
  if (!ctx.os) {
    return null;
  }
  return {
    icon: ctx.os === "android" ? "device-mobile" : "laptop",
    label: ctx.os_version ? `${ctx.os} ${ctx.os_version}` : ctx.os,
  };
}

/** 小数 4 桁 ≒ 11m。地名が引けなかったときだけ出る、素のままの記録。 */
const COORDINATE_DIGITS = 4;

/**
 * 記録された場所。地名が分かっていればそれを、まだなら座標を出す。
 *
 * 記録に残るのは座標のほうで、地名は読むための言い換え。行末 JSON に
 * 書き戻すと、どこにいたかがジオコーダの当たり外れで変わる。
 */
function locationSegment(ctx: DeviceContext, nameOf?: PlaceLookup): MetaSegment | null {
  if (!ctx.location) {
    return null;
  }
  const { latitude, longitude } = ctx.location;
  const label =
    nameOf?.(ctx.location) ??
    `${latitude.toFixed(COORDINATE_DIGITS)}, ${longitude.toFixed(COORDINATE_DIGITS)}`;
  return { icon: "map-pin", label };
}

function networkSegment(ctx: DeviceContext): MetaSegment | null {
  const icon = getNetworkIcon(ctx);
  if (!icon || !ctx.network_type) {
    return null;
  }
  return { icon, label: networkLabel(ctx.network_type) };
}

function batterySegment(ctx: DeviceContext): MetaSegment | null {
  const icon = getBatteryIcon(ctx);
  return icon ? { icon, label: `${ctx.battery}%` } : null;
}

/** 記録できていたものだけを、端末 → 場所 → 回線 → 電源の順に並べる。 */
export function entryMeta(context: DeviceContext | null, nameOf?: PlaceLookup): MetaSegment[] {
  if (!context) {
    return [];
  }
  return [
    deviceSegment(context),
    locationSegment(context, nameOf),
    networkSegment(context),
    batterySegment(context),
  ].filter((segment): segment is MetaSegment => segment !== null);
}
