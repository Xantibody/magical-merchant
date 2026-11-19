/**
 * The entry points the palette shows in its zero-query state, when nothing is typed.
 *
 * Every one of them is derived from IPC that already exists (`list_notes` /
 * `list_scrawl_dates`); no new command is added. The rows take the shape of the
 * existing `SearchHit`, so choosing one lands through the same path as a search hit.
 */

import type { SearchHit } from "./commands";
import { toIsoDate } from "./day-labels";
import { t } from "./i18n";
import type { NoteItem } from "./items";
import { countTagLists } from "./tags";
import type { TagCount } from "./tags";

const RECENT_LIMIT = 5;

function noteHit(item: NoteItem): SearchHit {
  return {
    kind: item.kind,
    title: item.title,
    snippet: "",
    date: item.date,
    filename: item.filename,
    index: null,
    tags: item.tags,
  };
}

/** The head of the list is the recent notes. Returns them as rows that open. */
export function recentNoteHits(items: NoteItem[]): SearchHit[] {
  return items.slice(0, RECENT_LIMIT).map((item) => noteHit(item));
}

/**
 * Counts the tags on the notes, most frequent first.
 *
 * Counting works the same way as for a `#tag` in the body (`tags.ts`). Counting the
 * raw spelling would put `Memo` and `memo` on separate rows, splitting one category
 * into two counts the reader has to press apart.
 */
export function countNoteTags(items: NoteItem[]): TagCount[] {
  return countTagLists(items.map((item) => item.tags));
}

export interface DayJump {
  label: string;
  hit: SearchHit;
}

/** Entry points for today and yesterday. Only days with records, never an empty day. */
export function dayJumpHits(recordedDates: string[], today: Date): DayJump[] {
  const dates = new Set(recordedDates);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const candidates: [string, string][] = [
    [t().day.today, toIsoDate(today)],
    [t().day.yesterday, toIsoDate(yesterday)],
  ];
  return candidates
    .filter(([, iso]) => dates.has(iso))
    .map(([label, iso]) => ({
      label,
      hit: {
        kind: "scrawl",
        title: label,
        snippet: "",
        date: iso,
        filename: null,
        index: null,
        tags: [],
      },
    }));
}
