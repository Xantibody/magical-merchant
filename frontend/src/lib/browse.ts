/**
 * The arithmetic of the Browse screen: the three axes kind / tag / period, and
 * the counts per axis.
 *
 * Filtering is not in core because the count shown on a chip is "the count
 * after the other axes are applied", and the population differs per axis: the
 * kind numbers come from the population filtered by tag and period only, the
 * tag numbers from the population filtered by kind and period only. Putting it
 * in core would mean inventing a facet protocol, so `browse_all` returns
 * everything once and the counting happens here (#279).
 *
 * Only pure functions that draw nothing. The date comes in as an argument:
 * reading `new Date()` inside gives a test that only reproduces at the moment
 * a boundary is crossed.
 */

import type { HitKind, SearchHit } from "./commands";
import { toIsoDate } from "./day-labels";
import { countTagLists, normalizeTag, sameTag } from "./tags";
import { digestWeekKey } from "./weekly-digest";

/** The period axis. Three choices; the default is "all". */
export type BrowsePeriod = "all" | "month" | "week";

/** Order of the period chips, from the widest to the narrowest. */
export const BROWSE_PERIODS: readonly BrowsePeriod[] = ["all", "month", "week"];

/**
 * Order of the kind chips: CODEX, then NOTE, then SCRAWL. Not exported: the
 * screen reads the order `kindFacets` returns, and the order is in there.
 */
const BROWSE_KINDS: readonly HitKind[] = ["codex", "note", "scrawl"];

export interface BrowseFilter {
  /** Chosen kinds. Empty means all. Several can be chosen; matching any one keeps the hit. */
  kinds: HitKind[];
  /** Chosen tags. Empty means all. As with kinds, matching any one keeps the hit. */
  tags: string[];
  period: BrowsePeriod;
}

/** The state with nothing filtered. */
export const NO_FILTER: BrowseFilter = { kinds: [], tags: [], period: "all" };

export function hasFilter(filter: BrowseFilter): boolean {
  return filter.kinds.length > 0 || filter.tags.length > 0 || filter.period !== "all";
}

/**
 * Key that names a list row. A note is its filename (the immutable ID); a
 * Scrawl entry has no file of its own, so it is the pair of day and line index.
 */
export function hitId(hit: SearchHit): string {
  return hit.kind === "scrawl" ? `${hit.date}#${hit.index ?? 0}` : (hit.filename ?? hit.date);
}

/**
 * Lower bound of the period. This day and later are kept. "all" has no boundary.
 *
 * The week starts on Monday, counted the same way as Scrawl's weekly digest
 * (`weekly-digest.ts`). Counted separately, the same "this week" would give a
 * different count on each screen.
 */
export function periodStart(period: BrowsePeriod, today: Date): string | null {
  if (period === "all") {
    return null;
  }
  if (period === "week") {
    return digestWeekKey(today);
  }
  return toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
}

/**
 * Whether the hit falls inside the period. An empty `date` is a note whose
 * frontmatter has no time; once a period is chosen there is no way to count
 * it, so it is dropped. Under "all" it is shown.
 */
function inPeriod(hit: SearchHit, start: string | null): boolean {
  return start === null || (hit.date !== "" && hit.date >= start);
}

function inKinds(hit: SearchHit, kinds: readonly HitKind[]): boolean {
  return kinds.length === 0 || kinds.includes(hit.kind);
}

/** Spelling differences are ignored, since a chip shows only the one representative (`tags.ts`). */
function inTags(hit: SearchHit, tags: readonly string[]): boolean {
  return tags.length === 0 || tags.some((tag) => hit.tags.some((own) => sameTag(own, tag)));
}

/** The result of applying all three axes. Order stays as received (newest first, as core sorted it). */
export function filterHits(
  hits: readonly SearchHit[],
  filter: BrowseFilter,
  today: Date,
): SearchHit[] {
  const start = periodStart(filter.period, today);
  return hits.filter(
    (hit) => inPeriod(hit, start) && inKinds(hit, filter.kinds) && inTags(hit, filter.tags),
  );
}

/** For one chip: how many hits there would be if it were pressed. */
export interface Facet<T> {
  value: T;
  count: number;
}

/**
 * Counts per kind. The population is filtered by tag and period, but not by
 * the chosen kinds: with that applied, every kind not currently chosen would
 * always be 0 and could not be picked again.
 */
export function kindFacets(
  hits: readonly SearchHit[],
  filter: BrowseFilter,
  today: Date,
): Facet<HitKind>[] {
  const base = filterHits(hits, { ...filter, kinds: [] }, today);
  return BROWSE_KINDS.map((kind) => ({
    value: kind,
    count: base.filter((hit) => hit.kind === kind).length,
  }));
}

/**
 * The tags to show as chips, most used first. Counted over everything before
 * filtering: if the order changed on every press, a hand aiming at the next
 * chip would press a different tag. The first spelling seen is the
 * representative (the folding in `tags.ts`).
 */
export function chipTags(hits: readonly SearchHit[]): string[] {
  return countTagLists(hits.map((hit) => hit.tags)).map((counted) => counted.tag);
}

/**
 * Counts per tag. The twin of the kind facet: the population is filtered by
 * kind and period, but not by the chosen tags. A tag the other axes emptied
 * stays with a count of 0: removing the chip would reorder the rows after a
 * press and change what the next press lands on.
 */
export function tagFacets(
  hits: readonly SearchHit[],
  filter: BrowseFilter,
  today: Date,
): Facet<string>[] {
  const base = filterHits(hits, { ...filter, tags: [] }, today);
  return chipTags(hits).map((tag) => ({
    value: tag,
    count: base.filter((hit) => inTags(hit, [tag])).length,
  }));
}

/**
 * Second line of a list row. The excerpt from `browse_all` is the first 40
 * characters of the body, and the title sits verbatim at its head: a note
 * starts with `# title`, and a Scrawl entry is its own title. The title is
 * already on the first line, so the overlap is dropped, and the result is
 * empty when nothing remains. The same thing is not read twice over two lines.
 */
export function rowSnippet(hit: SearchHit): string {
  const title = hit.title.trim();
  const rest = hit.snippet.replace(/^#+[ \t]*/u, "").trim();
  if (!title) {
    return rest;
  }
  if (rest.startsWith(title)) {
    return rest.slice(title.length).trim();
  }
  // The excerpt is the shorter one: the title did not fit in 40 characters, so all of it is part of the title
  return title.startsWith(rest.replace(/…$/u, "")) ? "" : rest;
}

/** A route that repeats the same name twice is read as one. */
function first(value?: string | string[]): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Copy the URL's `?kind=` and `?tag=` into a filter. A Scrawl tag chip opens
 * the screen with "Scrawl and that tag", so the filter to land on rides on the
 * route: carrying the desired shape in the URL is more natural than lifting the
 * screen's state so it can be touched from outside (same construction as
 * `?day=`).
 *
 * `null` when nothing readable is there. A filter nobody pressed is never
 * applied silently.
 */
export function browseSeed(params: {
  kind?: string | string[];
  tag?: string | string[];
}): BrowseFilter | null {
  const kind = BROWSE_KINDS.find((known) => known === first(params.kind));
  const tag = normalizeTag(first(params.tag));
  if (!kind && !tag) {
    return null;
  }
  return { kinds: kind ? [kind] : [], tags: tag ? [tag] : [], period: "all" };
}

export function toggleKind(kinds: readonly HitKind[], kind: HitKind): HitKind[] {
  return kinds.includes(kind) ? kinds.filter((own) => own !== kind) : [...kinds, kind];
}

/** Removal also goes by identity. With exact matching, a tag spelled differently would not come off when pressed. */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  return tags.some((own) => sameTag(own, tag))
    ? tags.filter((own) => !sameTag(own, tag))
    : [...tags, tag];
}
