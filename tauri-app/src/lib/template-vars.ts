/**
 * テンプレ変数のプレビュー解決。
 *
 * 本当の解決は core (`template/vars.rs`) がやる。ここにあるのは編集中の
 * タイトルとタグを「今日作るとこうなる」で見せるための写しで、打つたびに
 * IPC を往復させないために置いている。保存されるファイルはこの関数を
 * 一度も通らない。
 *
 * `{{prev}}` を含む行を丸ごと落とす規則はここには無い。プレビューが見せる
 * のは 1 行ぶんの値だけで、行の取捨は本文を書き出す core の仕事。
 */

import { t } from "./i18n";
import type { Locale } from "./i18n";
import { normalizeTag } from "./tags";

const WEEKDAYS: Record<Locale, string[]> = {
  ja: ["日", "月", "火", "水", "木", "金", "土"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** core の `format_stamp` と同じトークン。 */
export function formatStamp(date: Date, pattern: string): string {
  return pattern
    .replaceAll("YYYY", String(date.getFullYear()))
    .replaceAll("MM", pad(date.getMonth() + 1))
    .replaceAll("DD", pad(date.getDate()))
    .replaceAll("HH", pad(date.getHours()))
    .replaceAll("mm", pad(date.getMinutes()))
    .replaceAll("ss", pad(date.getSeconds()));
}

const DEFAULT_DATE = "YYYY-MM-DD";
const DEFAULT_TIME = "HH:mm";

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;

/**
 * 1 行ぶんの変数を解く。知らない変数は書かれたまま残す — 綴りを間違えた
 * 人が「消えた」ことにしか気づけないのは core と同じ理由で避ける。
 */
export function resolveLine(line: string, now: Date, locale: Locale, prev = ""): string {
  return line.replaceAll(PLACEHOLDER, (raw, inner: string) => {
    const at = inner.indexOf(":");
    const name = (at === -1 ? inner : inner.slice(0, at)).trim();
    const arg = at === -1 ? "" : inner.slice(at + 1).trim();

    if (name === "date") {
      return formatStamp(now, arg || DEFAULT_DATE);
    }
    if (name === "time") {
      return formatStamp(now, arg || DEFAULT_TIME);
    }
    if (name === "weekday") {
      return WEEKDAYS[locale][now.getDay()] ?? "";
    }
    if (name === "prev") {
      return prev;
    }
    return raw;
  });
}

/** 文字列に変数が含まれるか。タグを実線/破線で描き分けるのに使う。 */
export function hasVariable(text: string): boolean {
  return /\{\{[^}]*\}\}/.test(text);
}

/**
 * 自動タグを 1 つ足す。ノートのタグ(`note-meta.ts` の addTag)と違い、
 * 変数を含むものは打たれた形のまま残す — `{{date:YYYY-MM}}` を小文字に
 * 寄せると `YYYY` がトークンでなくなり、その月ではなく "yyyy-mm" という
 * 文字列がタグになる。解決したあとの値は core があらためて正規化する。
 */
export function addTemplateTag(tags: string[], raw: string): string[] {
  const trimmed = raw.trim().replace(/^#+/, "");
  if (!trimmed) {
    return tags;
  }
  const tag = hasVariable(trimmed) ? trimmed : normalizeTag(trimmed);
  return tags.includes(tag) ? tags : [...tags, tag];
}

/** ハイライト用に、変数とそれ以外へ切り分ける。 */
export interface TextRun {
  text: string;
  variable: boolean;
}

export function splitVariables(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(/\{\{[^}]*\}\}/g)) {
    const start = match.index;
    if (start > at) {
      runs.push({ text: text.slice(at, start), variable: false });
    }
    runs.push({ text: match[0], variable: true });
    at = start + match[0].length;
  }
  if (at < text.length) {
    runs.push({ text: text.slice(at), variable: false });
  }
  return runs;
}

export interface TemplateVar {
  /** カーソル位置に挿し込む文字列。 */
  token: string;
  /** チップに添える短い説明。言語を切り替えたら描き直したいので関数。 */
  label: () => string;
}

/** ツールバーと「変数を挿入」列に出す変数。PoC で解決できるのはこれだけ。 */
export const TEMPLATE_VARS: readonly TemplateVar[] = [
  { token: "{{date}}", label: () => t().templates.varDate },
  { token: "{{time}}", label: () => t().templates.varTime },
  { token: "{{weekday}}", label: () => t().templates.varWeekday },
  { token: "{{prev}}", label: () => t().templates.varPrev },
];
