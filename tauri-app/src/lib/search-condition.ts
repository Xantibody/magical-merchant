/**
 * The search field's condition: words, tags, one kind, one period. ADR 0002's "search is one
 * thing" starts here, with its first consumer (ADR 0015).
 *
 * AIDEV-NOTE: Browse does not use this. Its tags are OR and it counts every record, while here
 * tags are AND because adding a condition has to narrow, and the result is capped. Folding the
 * two together changes what Browse's chips mean.
 *
 * Pure functions; the date comes in as an argument, as in `browse.ts`.
 */

import type { HitKind, SearchFilter } from "./commands";
import { toIsoDate } from "./day-labels";
import { searchRequest } from "./search-scope";
import { digestWeekKey, yearAgoDate } from "./weekly-digest";

export type SearchKind = HitKind | "all";
export type SearchPeriod = "today" | "week" | "yearAgo";

export const SEARCH_KINDS: readonly SearchKind[] = ["all", "scrawl", "note", "codex"];
export const SEARCH_PERIODS: readonly SearchPeriod[] = ["today", "week", "yearAgo"];

/** core's `MAX_HITS`. A list this long may have stopped short, so the count says so. */
export const SEARCH_CAP = 100;

export interface SearchCondition {
  text: string;
  /** Tags pressed or carried in. A `#tag` typed in `text` counts too (`searchRequest`). */
  tags: string[];
  kind: SearchKind;
  period: SearchPeriod | null;
}

export const NO_CONDITION: SearchCondition = { text: "", tags: [], kind: "all", period: null };

export function hasCondition(condition: SearchCondition): boolean {
  return (
    condition.text.trim() !== "" ||
    condition.tags.length > 0 ||
    condition.kind !== "all" ||
    condition.period !== null
  );
}

export function periodRange(period: SearchPeriod, today: Date): { from: string; to: string } {
  const now = toIsoDate(today);
  if (period === "today") {
    return { from: now, to: now };
  }
  if (period === "week") {
    return { from: digestWeekKey(today), to: now };
  }
  const yearAgo = yearAgoDate(today);
  return { from: yearAgo, to: yearAgo };
}

interface SearchArgs {
  query: string;
  tags: string[];
  filter: SearchFilter;
}

/** The arguments of `search_records`. `null` while there is nothing to ask. */
export function searchArgs(condition: SearchCondition, today: Date): SearchArgs | null {
  if (!hasCondition(condition)) {
    return null;
  }
  const request = searchRequest(condition.text, condition.tags);
  const range = condition.period ? periodRange(condition.period, today) : null;
  return {
    query: request?.query ?? "",
    tags: request?.tags ?? [],
    filter: {
      kind: condition.kind === "all" ? null : condition.kind,
      from: range?.from ?? null,
      to: range?.to ?? null,
    },
  };
}
