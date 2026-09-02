/**
 * パレット検索の範囲。
 *
 * Timeline でタグを選んで絞った状態と ⌘K の検索は、もともと別々だった。
 * 絞ったまま探せるように、選んでいるタグをパレットに引き継いで
 * `search_all` の範囲として渡す。
 *
 * 範囲はタグの並びで、全部の付いた記録だけが残る(AND)。「#SF6 #ベガ #置き攻め」
 * のように、ノートを何枚も横断して一つの話題を集めたいときの形。
 */

import { ROUTES } from "./routes";
import { normalizeTag, parseTags, splitTagged } from "./tags";

export interface PaletteScope {
  /** 絞り込んでいるタグ(`#` なし)。全部の付いた記録だけが残る。 */
  tags: string[];
}

/**
 * `search_all` に渡す引数。何も打たず範囲も無ければ `null` — 発行しない。
 * タグだけあるときは空のクエリで呼び、そのタグの付いた記録を全部もらう。
 *
 * 打った文字の中の `#タグ` も範囲に数える。チップにするには行を選ぶ手間が
 * 要るが、打つだけなら手が止まらない。本文の `#タグ` と同じ規則(tags.ts)で
 * 拾うので、Timeline のチップと同じ字に寄る。残った文字だけが本文の検索語。
 */
export function searchRequest(
  query: string,
  scope: string[],
): { query: string; tags: string[] } | null {
  const text = splitTagged(query)
    .filter((segment) => !segment.tag)
    .map((segment) => segment.text)
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  const tags = [...new Set([...scope.map((tag) => normalizeTag(tag)), ...parseTags(query)])];
  if (!text && tags.length === 0) {
    return null;
  }
  return { query: text, tags };
}

/** 範囲を一目で示す文字。「#sf6 #ベガ」の形で、見出しや空の案内に出す。 */
export function scopeLabel(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

/**
 * ⌘K を押した場所で、パレットに引き継ぐ範囲を決める。
 *
 * 引き継ぐのは Timeline にいるときだけ。他の画面ではチップが見えておらず、
 * 見えていない絞り込みを黙って掛けると「無いはずがない」検索結果になる。
 */
export function paletteScopeAt(
  pathname: string,
  timelineTag: string | null,
): PaletteScope | undefined {
  if (pathname === ROUTES.TIMELINE && timelineTag) {
    return { tags: [timelineTag] };
  }
  return undefined;
}
