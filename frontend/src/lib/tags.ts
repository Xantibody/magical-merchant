/**
 * A `#tag` inside the body.
 *
 * Managing tags in a separate pane stops the writing hand and turns it into filing work.
 * Written mixed into the body, a tag can be left behind with the momentum of writing.
 *
 * The same rules exist in `core/src/utils/tags.rs`. That side has to read the whole text
 * to build the note list (the list summary only holds the first 100 characters); this side
 * interprets the body as it is on screen. Fix one and fix the other.
 *
 * One difference is deliberate: core skips code fences and code spans, because what it
 * reads is a whole Markdown note and it would otherwise pick up `#include`. What this side
 * reads is a single Scrawl line, and when a note preview is rendered markdown-it has
 * already separated out the code (`tag-markdown.ts`).
 */

/**
 * The character just before `#` must not be one a tag can use, so that a URL fragment such
 * as `https://example.com#frag` or the `#` of `C#` is not picked up.
 *
 * The rule is not "the character before is a space". Japanese puts no space between words,
 * so that rule would miss a perfectly ordinary line where `#run` follows a Japanese full
 * stop with no space in between.
 *
 * If a space follows the `#` it is a Markdown heading, so nothing matches at all.
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
 * The key that decides tag identity. Used only for matching and counting.
 *
 * A difference in case is the same tag to the writer, so only ASCII is folded to lower
 * case (Japanese has no case, and no locale-dependent conversion is brought in).
 * The same rule exists as `fold_tag` in `core/src/utils/tags.rs`.
 */
function foldTag(tag: string): string {
  return tag.replaceAll(/[A-Z]/gu, (c) => c.toLowerCase());
}

/** Whether two tags are the same. The difference in spelling is ignored. */
export function sameTag(a: string, b: string): boolean {
  return foldTag(a) === foldTag(b);
}

/**
 * Fold spellings that differ only in case into one. Order of appearance is kept, and the
 * one seen first is the one kept.
 *
 * "Which spelling represents the tag" is decided in this one place. A tag picked up from
 * the body and a tag coming from frontmatter must give the same answer, or different
 * screens show different letters.
 */
function foldUnique(tags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const tag of tags) {
    if (!seen.has(foldTag(tag))) {
      seen.set(foldTag(tag), tag);
    }
  }
  return [...seen.values()];
}

/**
 * Bring a tag passed in from outside into the shape `parseTags` returns.
 *
 * Only the decorative `#` and the surrounding whitespace are dropped; the spelling is not
 * touched. Case-insensitive matching is `sameTag`'s job, and flattening it here would take
 * the letters that were typed away from the caller.
 */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/u, "");
}

/**
 * Return the `#tag`s in the body in order of appearance, without duplicates.
 *
 * What is returned is the spelling as typed. Case is ignored only when dropping
 * duplicates, so `#Memo` and `#memo` become one and the one that appeared first is kept.
 */
export function parseTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(TAG)) {
    const tag = match.groups?.tag;
    if (tag) {
      tags.push(tag);
    }
  }
  return foldUnique(tags);
}

/**
 * Count tags that have already been extracted. One array is one record.
 *
 * A note's tags arrive from core exactly as written in frontmatter, so one note can claim
 * both `Memo` and `memo`. Count by the folded key and do not add the same record twice: a
 * chip's count must be "how many records carry it".
 */
export function countTagLists(lists: string[][]): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const list of lists) {
    for (const tag of foldUnique(list)) {
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

/**
 * Count from the most used down. On a tie, sort by name so the order does not wobble.
 * Spellings that differ only in case are the same tag. The chip shows the spelling seen
 * first.
 */
export function countTags(texts: string[]): TagCount[] {
  return countTagLists(texts.map((text) => parseTags(text)));
}

/** Split the body into tags and the rest. Used to draw the tags in color. */
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
 * The tag being typed just before the caret. `null` if the caret is not inside a tag.
 *
 * Right after a `#` is typed it returns an empty string. Candidates should show even
 * before a single character is entered, so that state is distinguished from "not a tag".
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
 * Keep only the tags that start with the characters being typed, in the same most-used
 * order. Both the candidates and the draft keep the spelling as typed, so both sides are
 * folded before they are compared.
 */
export function matchTagPrefix(known: TagCount[], draft: string): TagCount[] {
  const needle = foldTag(draft);
  return known.filter((t) => foldTag(t.tag).startsWith(needle));
}

/**
 * The meta line's suggestions for `query`. Tags the note already carries are left out, a tag
 * containing the query anywhere counts, and one that starts with it comes first. Within each
 * half the most-used order of `known` is kept.
 */
export function suggestTags(
  known: TagCount[],
  taken: readonly string[],
  query: string,
  max: number,
): TagCount[] {
  const needle = foldTag(normalizeTag(query));
  const open = known.filter(
    (t) => !taken.some((own) => sameTag(own, t.tag)) && foldTag(t.tag).includes(needle),
  );
  const prefix = open.filter((t) => foldTag(t.tag).startsWith(needle));
  const inner = open.filter((t) => !foldTag(t.tag).startsWith(needle));
  return [...prefix, ...inner].slice(0, max);
}

/**
 * Whether `query` would be a tag nobody has used yet. Offered as "add it as new" only then:
 * next to an existing tag that differs only in case, it would make a second spelling look
 * like the thing to do.
 */
export function isNewTag(known: TagCount[], taken: readonly string[], query: string): boolean {
  const tag = normalizeTag(query);
  return (
    tag !== "" && !known.some((t) => sameTag(t.tag, tag)) && !taken.some((own) => sameTag(own, tag))
  );
}
