import type { Note } from "./commands";
import { formatNoteGroupLabel } from "./day-labels";
import { parseTimelineEntry } from "./parse-timeline";
import type { DeviceContext } from "./parse-timeline";

export interface TimelineItem {
  kind: "timeline";
  id: string;
  date: string;
  index: number;
  raw: string;
  text: string;
  time: string;
  context: DeviceContext | null;
}

export interface NoteItem {
  kind: "note";
  id: string;
  filename: string;
  path: string;
  date: string;
  time: string;
  title: string;
  tags: string[];
  preview: string;
}

export type Item = TimelineItem | NoteItem;

export interface ItemGroup {
  label: string;
  items: Item[];
}

const UNTITLED = "(空のメモ)";

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line?.replace(/^#+\s*/, "").trim() ?? "";
}

export function toTimelineItems(date: string, raws: string[]): TimelineItem[] {
  return raws.map((raw, index) => {
    const parsed = parseTimelineEntry(raw);
    return {
      kind: "timeline",
      id: `${date}#${index}`,
      date,
      index,
      raw,
      text: parsed.text,
      time: parsed.time,
      context: parsed.context,
    };
  });
}

export function toNoteItems(notes: Note[]): NoteItem[] {
  return notes.map((note) => ({
    kind: "note",
    id: note.filename,
    filename: note.filename,
    path: note.path,
    date: note.time?.slice(0, 10) ?? "",
    time: note.time?.slice(11, 16) ?? "",
    title: firstLine(note.preview) || UNTITLED,
    tags: note.tags,
    preview: note.preview,
  }));
}

/** 連続する同じラベルだけをまとめる。日付順は呼び出し側の並びを尊重する。 */
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

export interface TimelineDay {
  /** `YYYY-MM-DD`。見出しの文字は表示側で作る。 */
  date: string;
  items: TimelineItem[];
}

/**
 * 暦日でまとめる。見出しの文字ではなく日付そのもので束ねるのは、
 * 「7月29日」のように見出しが日付から作られる日が複数あるため。
 */
export function groupTimelineByDay(items: TimelineItem[]): TimelineDay[] {
  const days: TimelineDay[] = [];
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

/** リスト行の 2 段目。「15:27 · macos」「08/03 · #sync #design」 */
export function itemMeta(item: Item): string {
  if (item.kind === "timeline") {
    return [item.time.slice(0, 5), item.context?.os].filter(Boolean).join(" · ");
  }
  const date = item.date ? item.date.slice(5).replace("-", "/") : "";
  const tags = item.tags.map((t) => `#${t}`).join(" ");
  return [date, tags].filter(Boolean).join(" · ");
}

export function itemTitle(item: Item): string {
  return item.kind === "timeline" ? firstLine(item.text) || UNTITLED : item.title;
}
