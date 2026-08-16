/**
 * ノートメタデータパネルの表示・編集ロジック。
 *
 * frontmatter の time はオフセット付き RFC 3339。ここでは Date に通さず
 * 文字列のまま扱う。一覧(`items.ts`)が slice で「書かれた土地の時刻」を
 * そのまま見せているので、パネルだけ端末のタイムゾーンに換算すると
 * 同じノートが画面ごとに違う時刻を名乗ることになる。
 */

import type { NoteContext } from "./commands";
import { t } from "./i18n";
import { networkLabel } from "./parse-timeline";
import { normalizeTag } from "./tags";

/** RFC 3339 の time を datetime-local input の値(分まで)にする。 */
export function toDatetimeLocal(rfc3339: string): string {
  return rfc3339.slice(0, 16);
}

/**
 * datetime-local の入力を保存する time に解決する。
 *
 * - 入力が元の値のままなら元の文字列を返す。input は秒を持たないので、
 *   組み立て直すと開いて閉じただけで秒が消える
 * - 変わっていたら元のオフセットを引き継ぐ。作成時のタイムゾーンは
 *   context と同じ「記録」であり、編集した端末のもので上書きしない
 */
export function resolveEditedTime(original: string, edited: string): string {
  if (edited === toDatetimeLocal(original)) {
    return original;
  }
  const offset = /(?<offset>Z|[+-]\d{2}:\d{2})$/.exec(original)?.groups?.offset ?? "";
  return `${edited}:00${offset}`;
}

/**
 * 読み取り専用で見せる日時。「2026/05/03 15:39」
 * time と同じく文字列のまま切り出す — 端末のタイムゾーンに換算しない。
 */
export function formatRecordedAt(rfc3339?: string): string {
  if (!rfc3339) {
    return "";
  }
  return `${rfc3339.slice(0, 10).replaceAll("-", "/")} ${rfc3339.slice(11, 16)}`;
}

/**
 * 入力をタグとして追加する。先頭の `#` は落とし、空と重複は無視する。
 * 同一性は本文の `#記法` と同じ規則で見る(`tags.ts`)。
 */
export function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw.trim().replace(/^#+/, ""));
  if (!tag || tags.includes(tag)) {
    return tags;
  }
  return [...tags, tag];
}

export interface ContextRow {
  label: string;
  value: string;
}

/** context のうち記録されているフィールドだけを、表示する行にする。 */
export function contextRows(ctx: NoteContext | undefined): ContextRow[] {
  if (!ctx) {
    return [];
  }
  const labels = t().meta;
  const rows: ContextRow[] = [];
  if (ctx.os) {
    rows.push({ label: labels.os, value: [ctx.os, ctx.os_version].filter(Boolean).join(" ") });
  }
  if (ctx.battery !== undefined) {
    rows.push({
      label: labels.battery,
      value: `${ctx.battery}%${ctx.is_charging ? ` (${labels.charging})` : ""}`,
    });
  }
  if (ctx.network_type) {
    rows.push({ label: labels.network, value: networkLabel(ctx.network_type) });
  }
  if (ctx.hostname) {
    rows.push({ label: labels.hostname, value: ctx.hostname });
  }
  if (ctx.location) {
    rows.push({
      label: labels.location,
      value: `${ctx.location.latitude.toFixed(4)}, ${ctx.location.longitude.toFixed(4)}`,
    });
  }
  if (ctx.locale) {
    rows.push({ label: labels.locale, value: ctx.locale });
  }
  return rows;
}
