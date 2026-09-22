/**
 * Display and edit logic of the note metadata panel.
 *
 * The frontmatter time is RFC 3339 with an offset. It is handled as a string here,
 * never through Date. The list (`items.ts`) shows "the local time where it was
 * written" as is via slice, so converting only the panel to the device's time zone
 * would make the same note claim a different time on each screen.
 */

import type { NoteContext } from "./commands";
import { t } from "./i18n";
import { networkLabel, sourceLabel } from "./parse-scrawl";
import { normalizeTag, sameTag } from "./tags";

/** Turns an RFC 3339 time into the value of a datetime-local input (to the minute). */
export function toDatetimeLocal(rfc3339: string): string {
  return rfc3339.slice(0, 16);
}

/**
 * Resolves the datetime-local input into the time to save.
 *
 * - If the input still equals the original value, return the original string. The
 *   input has no seconds, so rebuilding would drop them just by opening and closing
 * - If it changed, carry over the original offset. The creation time zone is a
 *   "record" like the context, and is not overwritten with the editing device's
 */
export function resolveEditedTime(original: string, edited: string): string {
  if (edited === toDatetimeLocal(original)) {
    return original;
  }
  const offset = /(?<offset>Z|[+-]\d{2}:\d{2})$/u.exec(original)?.groups?.offset ?? "";
  return `${edited}:00${offset}`;
}

/**
 * Date and time shown read-only. "2026/05/03 15:39"
 * Sliced as a string like time, with no conversion to the device's time zone.
 */
export function formatRecordedAt(rfc3339?: string): string {
  if (!rfc3339) {
    return "";
  }
  return `${rfc3339.slice(0, 10).replaceAll("-", "/")} ${rfc3339.slice(11, 16)}`;
}

/**
 * Adds the input as a tag. The leading `#` is dropped; empty and duplicates are ignored.
 * Identity follows the same rule as the body's `#tag` syntax (`tags.ts`).
 */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw);
  if (!tag || tags.some((own) => sameTag(own, tag))) {
    return tags;
  }
  return [...tags, tag];
}

export interface ContextRow {
  label: string;
  value: string;
}

/**
 * Turns only the recorded fields of the context into rows to display.
 *
 * `source` sits directly under the frontmatter, not inside the context (it is not
 * device state), but to the reader it is one record of "where and with what this was
 * written", so it goes in the same table.
 */
export function contextRows(ctx: NoteContext | undefined, source?: string): ContextRow[] {
  const labels = t().meta;
  const rows: ContextRow[] = [];
  if (ctx?.os) {
    rows.push({ label: labels.os, value: [ctx.os, ctx.os_version].filter(Boolean).join(" ") });
  }
  if (ctx?.battery !== undefined) {
    rows.push({
      label: labels.battery,
      value: `${ctx.battery}%${ctx.is_charging ? ` (${labels.charging})` : ""}`,
    });
  }
  if (ctx?.network_type) {
    rows.push({ label: labels.network, value: networkLabel(ctx.network_type) });
  }
  if (ctx?.hostname) {
    rows.push({ label: labels.hostname, value: ctx.hostname });
  }
  if (ctx?.location) {
    rows.push({
      label: labels.location,
      value: `${ctx.location.latitude.toFixed(4)}, ${ctx.location.longitude.toFixed(4)}`,
    });
  }
  if (ctx?.locale) {
    rows.push({ label: labels.locale, value: ctx.locale });
  }
  if (source) {
    rows.push({ label: labels.source, value: sourceLabel(source) });
  }
  return rows;
}
