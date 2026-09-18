/**
 * 本文中の `#タグ`。
 *
 * タグを別枠で管理させると、書く手が止まって分類の作業になる。本文に混ぜて
 * 書けるなら、書いた勢いのまま残せる。
 *
 * 同じ規則が `core/src/utils/tags.rs` にもある。あちらはノート一覧を作るのに
 * 全文を読む必要があり（一覧の要約は先頭 100 文字しか持たない）、こちらは
 * 画面で本文をそのまま解釈する。片方を直したらもう片方も直すこと。
 *
 * ひとつだけ意図的に違う: core はコードフェンスとコードスパンを読み飛ばす。
 * あちらが読むのは Markdown のノート全文で、`#include` を拾ってしまうため。
 * こちらが読むのはタイムラインの 1 行で、ノートのプレビュー描画では
 * markdown-it が先にコードを切り分けている(`tag-markdown.ts`)。
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

/**
 * タグの同一性を決める鍵。突き合わせと数え上げにだけ使う。
 *
 * 大文字小文字の違いは書き手にとって同じタグなので ASCII だけ小文字に寄せる
 * (日本語に大文字小文字は無く、ロケール依存の変換も持ち込まない)。
 * 同じ規則が `core/src/utils/tags.rs` の `fold_tag` にもある。
 */
function foldTag(tag: string): string {
  return tag.replaceAll(/[A-Z]/gu, (c) => c.toLowerCase());
}

/** 2 つのタグが同じか。綴りの違いは見ない。 */
export function sameTag(a: string, b: string): boolean {
  return foldTag(a) === foldTag(b);
}

/**
 * 外から渡されたタグを、`parseTags` が返す形に揃える。
 *
 * 落とすのは飾りの `#` と前後の空白だけで、綴りには触らない。大小を無視した
 * 突き合わせは `sameTag` の仕事で、ここで潰すと打った字が呼び出し側から消える。
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/u, "");
}

/**
 * 本文の `#タグ` を、出てきた順に重複なく返す。
 *
 * 返すのは打たれた綴りそのもの。重複を落とすときだけ大小を無視するので、
 * `#Memo` と `#memo` は 1 つになり、残るのは先に出てきたほう。
 */
export function parseTags(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(TAG)) {
    const tag = match.groups?.tag;
    if (tag && !seen.has(foldTag(tag))) {
      seen.set(foldTag(tag), tag);
    }
  }
  return [...seen.values()];
}

/**
 * よく使うものから順に数える。同数なら名前順にして並びが揺れないようにする。
 * 大小だけ違う綴りは同じタグ。チップに出すのは最初に見た綴り。
 */
export function countTags(texts: string[]): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const text of texts) {
    for (const tag of parseTags(text)) {
      const seen = counts.get(foldTag(tag));
      if (seen) {
        seen.count += 1;
      } else {
        counts.set(foldTag(tag), { tag, count: 1 });
      }
    }
  }
  return [...counts.values()].toSorted((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
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

/**
 * 打ちかけの文字で始まるタグだけを、よく使う順のまま残す。
 * 候補も打ちかけも綴りは打った形のままなので、両側を畳んで比べる。
 */
export function matchTagPrefix(known: TagCount[], draft: string): TagCount[] {
  const needle = foldTag(draft);
  return known.filter((t) => foldTag(t.tag).startsWith(needle));
}
