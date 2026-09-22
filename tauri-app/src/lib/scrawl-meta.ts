import type { IconName } from "../components/Icon";
import { getBatteryIcon, getNetworkIcon, networkLabel, sourceLabel } from "./parse-scrawl";
import type { DeviceContext } from "./parse-scrawl";

/** One piece of the situation at capture time, listed below an entry's body. */
export interface MetaSegment {
  icon: IconName;
  label: string;
}

/** Looks up the place name for a coordinate. undefined while it is not resolved yet. */
export type PlaceLookup = (location: { latitude: number; longitude: number }) => string | undefined;

/**
 * The device that recorded the entry. Scrawl's end-of-line JSON (`DeviceContext`) and a note's
 * frontmatter (`NoteContext`) differ only in whether os is required, so this takes just the two
 * keys it needs: the same "which device wrote this" is not spelled two ways.
 */
export function deviceSegment(
  ctx: { os?: string; os_version?: string } | null | undefined,
): MetaSegment | null {
  if (!ctx?.os) {
    return null;
  }
  return {
    icon: ctx.os === "android" ? "device-mobile" : "laptop",
    label: ctx.os_version ? `${ctx.os} ${ctx.os_version}` : ctx.os,
  };
}

/** 4 decimal places is about 11 m. The raw record, shown only when no place name resolved. */
const COORDINATE_DIGITS = 4;

/**
 * The recorded place. Shows the place name when it is known, the coordinates until then.
 *
 * What the record keeps is the coordinates; the place name is only a readable paraphrase. Writing
 * it back into the end-of-line JSON would make where you were depend on the geocoder's luck.
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

function sourceSegment(ctx: DeviceContext): MetaSegment | null {
  return ctx.s ? { icon: "pencil", label: sourceLabel(ctx.s) } : null;
}

/**
 * Lists only what could be recorded, in the order device, place, network, battery, source.
 * Source goes last because it was added to the record later than device and place, so older
 * entries never look ordered differently.
 */
export function entryMeta(context: DeviceContext | null, nameOf?: PlaceLookup): MetaSegment[] {
  if (!context) {
    return [];
  }
  return [
    deviceSegment(context),
    locationSegment(context, nameOf),
    networkSegment(context),
    batterySegment(context),
    sourceSegment(context),
  ].filter((segment): segment is MetaSegment => segment !== null);
}
