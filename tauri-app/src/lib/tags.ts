/**
 * 本文中の `#タグ`。
 *
 * タグを別枠で管理させると、書く手が止まって分類の作業になる。本文に混ぜて
 * 書けるなら、書いた勢いのまま残せる。
 *
 * 同じ規則が `core/src/utils/tags.rs` にもある。あちらはノート一覧を作るのに
 * 全文を読む必要があり（一覧の要約は先頭 100 文字しか持たない）、こちらは
 * 画面で本文をそのまま解釈する。片方を直したらもう片方も直すこと。
 */

/**
 * `#` の直前がタグに使える文字でないこと。`https://example.com#frag` のような
 * URL の断片や `C#` の `#` を拾わないため。
 *
 * 「直前が空白」ではない。日本語は語の間に空白を置かないので、それだと
 * 「走った。#run」のような、ごく普通の書き方を取りこぼす。
 *
 * `#` の直後が空白なら Markdown の見出しなので、そもそも 1 文字も一致しない。
 */
const TAG = /(?<![\p{L}\p{N}_-])#(?<tag>[\p{L}\p{N}_-]+)/gu;

export interface TagCount {
  tag: string;
  count: number;
}

export interface TagSegment {
  text: string;
  tag: boolean;
}

/** 本文の `#タグ` を、出てきた順に重複なく返す。 */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(TAG)) {
    const tag = match.groups?.tag;
    if (tag) {
      seen.add(tag);
    }
  }
  return [...seen];
}

/** よく使うものから順に数える。同数なら名前順にして並びが揺れないようにする。 */
export function countTags(texts: string[]): TagCount[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const tag of parseTags(text)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 本文をタグとそれ以外に切り分ける。色を付けて描くために使う。 */
export function splitTagged(text: string): TagSegment[] {
  const segments: TagSegment[] = [];
  let at = 0;

  for (const match of text.matchAll(TAG)) {
    const start = match.index;
    if (start > at) {
      segments.push({ text: text.slice(at, start), tag: false });
    }
    segments.push({ text: match[0], tag: true });
    at = start + match[0].length;
  }

  if (at < text.length) {
    segments.push({ text: text.slice(at), tag: false });
  }
  return segments;
}

/**
 * カーソルの直前で打ちかけているタグ。タグの途中でなければ `null`。
 *
 * `#` を打った直後は空文字を返す。まだ 1 文字も入っていない状態でも候補を
 * 出したいので、「タグではない」とは区別する。
 */
export function tagDraftAt(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const hash = before.lastIndexOf("#");
  if (hash === -1) {
    return null;
  }

  const boundary = hash === 0 || !/[\p{L}\p{N}_-]/u.test(before[hash - 1]);
  if (!boundary) {
    return null;
  }

  const draft = before.slice(hash + 1);
  return /^[\p{L}\p{N}_-]*$/u.test(draft) ? draft : null;
}

/** 打ちかけの文字で始まるタグだけを、よく使う順のまま残す。 */
export function matchTagPrefix(known: TagCount[], draft: string): TagCount[] {
  const needle = draft.toLowerCase();
  return known.filter((t) => t.tag.toLowerCase().startsWith(needle));
}
