import type { Note, NoteKind } from "./commands";
import { daysBetween, formatMonthDay, formatNoteGroupLabel, parseIsoDate } from "./day-labels";
import { t } from "./i18n";
import { resolveNoteView } from "./note-view";
import { parseScrawlEntry } from "./parse-scrawl";
import { isPreservedEmptyLine } from "./preserved-empty-line";
import type { DeviceContext } from "./parse-scrawl";

export interface ScrawlItem {
  kind: "scrawl";
  id: string;
  date: string;
  index: number;
  raw: string;
  text: string;
  time: string;
  context: DeviceContext | null;
}

export interface NoteItem {
  /** A `codex` is one record of the same shape as a Note. Only the surface differs; the row is the same. */
  kind: NoteKind;
  id: string;
  filename: string;
  path: string;
  date: string;
  time: string;
  title: string;
  tags: string[];
  preview: string;
  /** Datetime of the entry this note was promoted from. Scrawl uses it to show the chip. */
  origin?: string;
  /** A note made read-only. The list shows a lock for it. */
  readOnly: boolean;
  /** Name of the template it was born from. Used to look up the examples when it is opened. */
  template?: string;
  /** Number of committed versions. Only a Codex row has it; it shows on the folded-corner page mark. */
  versionCount?: number;
  /** Whether the draft has moved on from the latest version. Codex rows only. */
  dirty?: boolean;
}

export type Item = ScrawlItem | NoteItem;

export interface ItemGroup {
  label: string;
  items: Item[];
}

/** What a record without a title is called. Exists only so a list row is not left blank. */
const untitled = (): string => t().notes.untitled;

function firstLine(text: string): string {
  // Milkdown saves an empty line as a <br /> line. The title skips those too
  const line = text.split("\n").find((l) => l.trim().length > 0 && !isPreservedEmptyLine(l));
  return line?.replace(/^#+\s*/u, "").trim() ?? "";
}

/**
 * Turns one day's lines into ScrawlItems, newest first (the order the screen shows).
 * The file is append-only, so its lines are oldest first. `index` keeps the original line position.
 * Update and delete point at a line by this index, so the reversal happens after the indexes are set.
 */
export function toScrawlItems(date: string, raws: string[]): ScrawlItem[] {
  return raws
    .map((raw, index) => {
      const parsed = parseScrawlEntry(raw);
      return {
        kind: "scrawl" as const,
        id: `${date}#${index}`,
        date,
        index,
        raw,
        text: parsed.text,
        time: parsed.time,
        context: parsed.context,
      };
    })
    .toReversed();
}

export function toNoteItems(notes: Note[]): NoteItem[] {
  return notes.map((note) => ({
    kind: note.kind,
    id: note.filename,
    filename: note.filename,
    path: note.path,
    date: note.time?.slice(0, 10) ?? "",
    time: note.time?.slice(11, 16) ?? "",
    title: firstLine(note.preview) || untitled(),
    tags: note.tags,
    preview: note.preview,
    origin: note.origin,
    readOnly: resolveNoteView(note.view) === "preview",
    template: note.template,
    versionCount: note.version_count,
    dirty: note.dirty,
  }));
}

/** Key that names an entry in the origin format (`YYYY-MM-DDTHH:MM:SS`). Built the same way as at promotion. */
export function originKeyOf(item: ScrawlItem): string {
  return `${item.date}T${item.time}`;
}

/**
 * Makes promoted notes retrievable by the origin datetime itself. The key is the
 * same string as the entry side's `originKeyOf`, so the chip can sit right under
 * the original entry. Nothing is written into the entry's file, so reordering or
 * adding and removing lines cannot shift it.
 */
export function notesByOrigin(items: NoteItem[]): Map<string, NoteItem[]> {
  const map = new Map<string, NoteItem[]>();
  for (const item of items) {
    if (item.origin) {
      const notes = map.get(item.origin);
      if (notes) {
        notes.push(item);
      } else {
        map.set(item.origin, [item]);
      }
    }
  }
  return map;
}

/**
 * Groups the notes whose source entry can no longer be found, by the calendar day
 * of the origin. Deleting an entry leaves the note, so it is moved right under the
 * day heading to keep its entrance visible. The match runs against all entries
 * before filtering: reading an entry that is merely hidden by a tag as "gone"
 * would make unrelated chips pop up under the heading on every filter.
 */
export function orphanNotesByDate(notes: NoteItem[], items: ScrawlItem[]): Map<string, NoteItem[]> {
  const known = new Set(items.map((item) => originKeyOf(item)));
  const map = new Map<string, NoteItem[]>();
  for (const note of notes) {
    const date = note.origin?.slice(0, 10);
    if (date && !known.has(note.origin ?? "")) {
      const found = map.get(date);
      if (found) {
        found.push(note);
      } else {
        map.set(date, [note]);
      }
    }
  }
  return map;
}

/** Groups only consecutive items with the same label. The date order is whatever the caller passed. */
function groupBy(items: Item[], labelOf: (item: Item) => string): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of items) {
    const label = labelOf(item);
    const last = groups.at(-1);
    if (last?.label === label) {
      last.items.push(item);
    } else {
      groups.push({ label, items: [item] });
    }
  }
  return groups;
}

/**
 * Replaces one day's items in a Scrawl list sorted newest first.
 * Re-reading every day on each record would cost one IPC per day for a single save,
 * so only the day written is re-read and spliced in here.
 */
export function replaceDayItems(
  items: ScrawlItem[],
  date: string,
  dayItems: ScrawlItem[],
): ScrawlItem[] {
  const kept = items.filter((item) => item.date !== date);
  const at = kept.findIndex((item) => item.date < date);
  const insertAt = at === -1 ? kept.length : at;
  return [...kept.slice(0, insertAt), ...dayItems, ...kept.slice(insertAt)];
}

export interface DeleteTarget {
  date: string;
  index: number;
  /** The line as it read when selected. core uses it to confirm it is the same record. */
  raw: string;
}

/**
 * Decides the execution order of a bulk delete. delete_scrawl_entry points at a
 * line by date + index, so deleting from the smallest index within a day shifts
 * the remaining lines up and later indexes point at other lines. Grouping by day
 * and sorting by index descending avoids the shift. Days keep the selection order.
 */
export function planBulkDelete(targets: DeleteTarget[]): DeleteTarget[] {
  const byDate = new Map<string, DeleteTarget[]>();
  for (const target of targets) {
    const group = byDate.get(target.date);
    if (group) {
      group.push(target);
    } else {
      byDate.set(target.date, [target]);
    }
  }
  return [...byDate.values()].flatMap((group) => group.toSorted((a, b) => b.index - a.index));
}

/**
 * The neighbouring id to select after a delete. Prefers the one directly above
 * in the list and falls to the one below only when the first was deleted. Notes
 * are newest first, so "above" is the more recent record, the same place the eye
 * goes right after a delete. null when nothing is left.
 */
export function neighborOf(items: readonly { id: string }[], id: string): string | null {
  const at = items.findIndex((item) => item.id === id);
  if (at === -1) {
    return null;
  }
  return items[at - 1]?.id ?? items[at + 1]?.id ?? null;
}

export interface ScrawlDay {
  /** `YYYY-MM-DD`. The heading text is built on the display side. */
  date: string;
  items: ScrawlItem[];
}

/**
 * Groups by calendar day. It groups on the date itself rather than the heading
 * text because several days get a heading built from the date, like `7月29日`.
 */
export function groupScrawlByDay(items: ScrawlItem[]): ScrawlDay[] {
  const days: ScrawlDay[] = [];
  for (const item of items) {
    const last = days.at(-1);
    if (last?.date === item.date) {
      last.items.push(item);
    } else {
      days.push({ date: item.date, items: [item] });
    }
  }
  return days;
}

export function groupNotes(items: NoteItem[], today: Date): ItemGroup[] {
  return groupBy(items, (item) => formatNoteGroupLabel(item.date, today));
}

/**
 * The creation datetime shown right under the title, like `2026年9月5日 21:14`.
 * The filename is the immutable ID that sync and the widgets point at, not
 * something to show a person. This is what a person reads.
 */
export function noteCreatedLabel(item: NoteItem): string {
  const date = parseIsoDate(item.date);
  if (!date) {
    return item.time;
  }
  const day = t().day.fullDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return [day, item.time].filter(Boolean).join(" ");
}

/**
 * The note one before (-1) or after (+1) in list order. Stops at the ends:
 * wrapping around to an unknown note while stepping by key is more confusing.
 */
export function stepNote(
  items: NoteItem[],
  id: string | undefined,
  step: number,
): string | undefined {
  const index = items.findIndex((item) => item.id === id);
  return index === -1 ? undefined : items[index + step]?.id;
}

/**
 * The one value at the right edge of a list row: the time for today's notes,
 * the date for older ones. Showing "08/04" on today's note says nothing the
 * heading does not already say; the time tells which one was written just now.
 */
export function noteRowStamp(item: NoteItem, today: Date): string {
  const date = parseIsoDate(item.date);
  return date && daysBetween(date, today) === 0 ? item.time : formatMonthDay(item.date);
}

export function itemTitle(item: Item): string {
  return item.kind === "scrawl" ? firstLine(item.text) || untitled() : item.title;
}
