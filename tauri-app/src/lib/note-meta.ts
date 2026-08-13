/**
 * ノートメタデータパネルの表示・編集ロジック。
 *
 * frontmatter の time はオフセット付き RFC 3339。ここでは Date に通さず
 * 文字列のまま扱う。一覧(`items.ts`)が slice で「書かれた土地の時刻」を
 * そのまま見せているので、パネルだけ端末のタイムゾーンに換算すると
 * 同じノートが画面ごとに違う時刻を名乗ることになる。
 */

import type { NoteContext } from "./commands";

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

/** 入力をタグとして追加する。先頭の `#` は落とし、空と重複は無視する。 */
export function addTag(tags: string[], raw: string): string[] {
  const tag = raw.trim().replace(/^#+/, "");
  if (!tag || tags.includes(tag)) {
    return tags;
  }
  return [...tags, tag];
}

const NETWORK_LABELS: Record<string, string> = {
  WiFi: "Wi-Fi",
  Ethernet: "有線",
  Mobile: "モバイル回線",
  Offline: "オフライン",
};

export interface ContextRow {
  label: string;
  value: string;
}

/** context のうち記録されているフィールドだけを、表示する行にする。 */
export function contextRows(ctx: NoteContext | undefined): ContextRow[] {
  if (!ctx) {
    return [];
  }
  const rows: ContextRow[] = [];
  if (ctx.os) {
    rows.push({ label: "OS", value: [ctx.os, ctx.os_version].filter(Boolean).join(" ") });
  }
  if (ctx.battery !== undefined) {
    rows.push({
      label: "バッテリー",
      value: `${ctx.battery}%${ctx.is_charging ? " (充電中)" : ""}`,
    });
  }
  if (ctx.network_type) {
    rows.push({ label: "ネットワーク", value: NETWORK_LABELS[ctx.network_type] ?? ctx.network_type });
  }
  if (ctx.hostname) {
    rows.push({ label: "ホスト名", value: ctx.hostname });
  }
  if (ctx.location) {
    rows.push({
      label: "位置",
      value: `${ctx.location.latitude.toFixed(4)}, ${ctx.location.longitude.toFixed(4)}`,
    });
  }
  if (ctx.locale) {
    rows.push({ label: "ロケール", value: ctx.locale });
  }
  return rows;
}
