/**
 * パレット検索の範囲。
 *
 * Timeline でタグを選んで絞った状態と ⌘K の検索は、もともと別々だった。
 * 絞ったまま探せるように、選んでいるタグをパレットに引き継いで
 * `search_all` の範囲として渡す。
 */

import { ROUTES } from "./routes";

export interface PaletteScope {
  /** 絞り込んでいるタグ(`#` なし)。 */
  tag: string;
}

/**
 * `search_all` に渡す引数。何も打たず範囲も無ければ `null` — 発行しない。
 * タグだけあるときは空のクエリで呼び、そのタグの付いた記録を全部もらう。
 */
export function searchRequest(
  query: string,
  tag: string | null,
): { query: string; tags: string[] } | null {
  if (!query.trim() && !tag) {
    return null;
  }
  return { query, tags: tag ? [tag] : [] };
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
    return { tag: timelineTag };
  }
  return undefined;
}
