/**
 * The scope of the palette search.
 *
 * Narrowing by a chosen tag in Browse and the ⌘K search were originally separate. So that
 * you can search while still narrowed, the chosen tags are carried into the palette and
 * passed as the scope of `search_all`.
 *
 * The scope is a list of tags, and only records carrying all of them remain (AND). It is
 * the shape for gathering one topic across many notes, such as `#SF6 #ベガ #置き攻め`.
 */

import { ROUTES } from "./routes";
import { normalizeTag, parseTags, sameTag, splitTagged } from "./tags";

export interface PaletteScope {
  /** The tags being narrowed by (no `#`). Only records carrying all of them remain. */
  tags: string[];
}

/**
 * The arguments passed to `search_all`. `null` if nothing was typed and there is no scope:
 * it is not issued. With tags only it is called with an empty query, and gets back every
 * record carrying those tags.
 *
 * A `#tag` inside what was typed counts towards the scope too. Making a chip costs the
 * trouble of picking a row; typing alone does not stop the hand. It is picked up by the
 * same rules as a `#tag` in a body (tags.ts), so it lands on the same letters as a Scrawl
 * chip. Only the text that is left is the search term for the body.
 */
export function searchRequest(
  query: string,
  scope: string[],
): { query: string; tags: string[] } | null {
  const text = splitTagged(query)
    .filter((segment) => !segment.tag)
    .map((segment) => segment.text)
    .join("")
    .replaceAll(/\s+/gu, " ")
    .trim();
  // Pass the spelling as typed (core folds it and matches). Only duplicates are dropped, ignoring case
  const tags: string[] = [];
  for (const tag of [...scope.map((t) => normalizeTag(t)), ...parseTags(query)]) {
    if (tag && !tags.some((own) => sameTag(own, tag))) {
      tags.push(tag);
    }
  }
  if (!text && tags.length === 0) {
    return null;
  }
  return { query: text, tags };
}

/** The text that shows the scope at a glance. In the form `#sf6 #ベガ`, shown in a heading or an empty-state message. */
export function scopeLabel(tags: string[]): string {
  return tags.map((tag) => `#${tag}`).join(" ");
}

/**
 * Decide, from where ⌘K was pressed, the scope carried into the palette.
 *
 * It is carried only from Browse. On another screen the chips are not visible, and
 * applying a filter no one can see silently produces search results that "cannot possibly
 * be missing that". A Scrawl chip opens Browse when pressed, so the state of being
 * narrowed by a tag now exists only there.
 */
export function paletteScopeAt(pathname: string, tags: string[]): PaletteScope | undefined {
  // Only one tag can be carried over. Browse's tags mean "has any of them" (OR), but the
  // tags of `search_all` mean "has all of them" (AND). Passing two or more straight
  // through would make the records on screen that carry only one of them vanish the
  // moment the palette opens, which is not "search inside what you can see"
  if (pathname === ROUTES.BROWSE && tags.length === 1) {
    return { tags };
  }
  return undefined;
}
