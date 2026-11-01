/**
 * Scrawl's rows: every kind of record, by day. Scrawl entries and Notes / Codex records arrive
 * from separate reads, so they meet here.
 */

import { originKeyOf } from "./items";
import type { NoteItem, ScrawlItem } from "./items";

export type ScrawlRow =
  | { kind: "scrawl"; time: string; item: ScrawlItem }
  | { kind: "note"; time: string; note: NoteItem };

export interface ScrawlDay {
  date: string;
  rows: ScrawlRow[];
}

/**
 * Newest day first, each day's newest record first. Notes reach back only as far as the loaded
 * entries, and a note grown from an entry on screen is left to that entry's chip.
 */
export function scrawlDays(entries: ScrawlItem[], notes: NoteItem[], today: string): ScrawlDay[] {
  const shownOrigins = new Set(entries.map((item) => originKeyOf(item)));
  const oldest = entries.reduce((min, item) => (item.date < min ? item.date : min), today);

  const byDate = new Map<string, ScrawlRow[]>();
  const push = (date: string, row: ScrawlRow): void => {
    const rows = byDate.get(date) ?? [];
    rows.push(row);
    byDate.set(date, rows);
  };

  for (const item of entries) {
    push(item.date, { kind: "scrawl", time: item.time.slice(0, 5), item });
  }
  const inRange = (note: NoteItem): boolean => note.date >= oldest && note.date <= today;
  const ownRow = (note: NoteItem): boolean => !note.origin || !shownOrigins.has(note.origin);
  for (const note of notes.filter((n) => inRange(n) && ownRow(n))) {
    push(note.date, { kind: "note", time: note.time, note });
  }

  return [...byDate.entries()]
    .toSorted(([a], [b]) => b.localeCompare(a))
    .map(([date, rows]) => ({
      date,
      rows: rows.toSorted((a, b) => b.time.localeCompare(a.time)),
    }));
}
