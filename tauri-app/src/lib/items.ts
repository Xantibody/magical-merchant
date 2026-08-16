import type { Note } from "./commands";
import { formatNoteGroupLabel } from "./day-labels";
import { t } from "./i18n";
import { parseTimelineEntry } from "./parse-timeline";
import { isPreservedEmptyLine } from "./preserved-empty-line";
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
  /** 昇格元エントリの日時。タイムラインのチップ表示が日付部分を使う。 */
  origin?: string;
}

export type Item = TimelineItem | NoteItem;

export interface ItemGroup {
  label: string;
  items: Item[];
}

/** 題を持たない記録の呼び名。一覧の行が空欄になるのを避けるためだけのもの。 */
const untitled = (): string => t().notes.untitled;

function firstLine(text: string): string {
  // Milkdown は空行を <br /> 行として保存する。タイトルはそれも読み飛ばす
  const line = text.split("\n").find((l) => l.trim().length > 0 && !isPreservedEmptyLine(l));
  return line?.replace(/^#+\s*/, "").trim() ?? "";
}

/**
 * 1 日ぶんの行を、新しい順（画面と同じ並び）の TimelineItem にする。
 * ファイルは追記なので行は古い順に並ぶ。index には元の行位置を残す。
 * 更新・削除はこの index で行を指すので、並べ替えは index を振った後にやる。
 */
export function toTimelineItems(date: string, raws: string[]): TimelineItem[] {
  return raws
    .map((raw, index) => {
      const parsed = parseTimelineEntry(raw);
      return {
        kind: "timeline" as const,
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
    kind: "note",
    id: note.filename,
    filename: note.filename,
    path: note.path,
    date: note.time?.slice(0, 10) ?? "",
    time: note.time?.slice(11, 16) ?? "",
    title: firstLine(note.preview) || untitled(),
    tags: note.tags,
    preview: note.preview,
    origin: note.origin,
  }));
}

/**
 * 昇格ノートを origin の暦日で引けるようにする。タイムラインの日毎の
 * チップはここから導出する — エントリ側のファイルには何も書いていない
 * ので、並び替えや行の増減でズレる心配がない。
 */
export function notesByOriginDate(items: NoteItem[]): Map<string, NoteItem[]> {
  const map = new Map<string, NoteItem[]>();
  for (const item of items) {
    const date = item.origin?.slice(0, 10);
    if (date) {
      const notes = map.get(date);
      if (notes) {
        notes.push(item);
      } else {
        map.set(date, [item]);
      }
    }
  }
  return map;
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

/**
 * 新しい順に並んだタイムラインの、1 日ぶんだけを差し替える。
 * 記録のたびに全日を読み直すと保存 1 回に日数ぶんの IPC がかかるので、
 * 書いた日だけ読み直してここで継ぎ合わせる。
 */
export function replaceDayItems(
  items: TimelineItem[],
  date: string,
  dayItems: TimelineItem[],
): TimelineItem[] {
  const kept = items.filter((item) => item.date !== date);
  const at = kept.findIndex((item) => item.date < date);
  const insertAt = at === -1 ? kept.length : at;
  return [...kept.slice(0, insertAt), ...dayItems, ...kept.slice(insertAt)];
}

export interface DeleteTarget {
  date: string;
  index: number;
}

/**
 * まとめて消すときの実行順を決める。delete_timeline_entry は date + index で
 * 行を指すので、同じ日の中で小さい index から消すと残りの行が繰り上がって
 * 後続の index が別の行を指してしまう。日ごとにまとめ、index の大きい順に
 * 並べることでズレを起こさない。日どうしの順は選択順を尊重する。
 */
export function planBulkDelete(targets: DeleteTarget[]): DeleteTarget[] {
  const byDate = new Map<string, number[]>();
  for (const { date, index } of targets) {
    const indexes = byDate.get(date);
    if (indexes) {
      indexes.push(index);
    } else {
      byDate.set(date, [index]);
    }
  }
  return [...byDate].flatMap(([date, indexes]) =>
    indexes.toSorted((a, b) => b - a).map((index) => ({ date, index })),
  );
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
  const tags = item.tags.map((tag) => `#${tag}`).join(" ");
  return [date, tags].filter(Boolean).join(" · ");
}

/**
 * 詳細ヘッダの作成日時。「2026/05/03 15:39」
 * ファイル名は同期やウィジェットが指す不変の ID であって、人に見せる
 * ものではない。人が読むのはこちら。
 */
export function noteCreatedLabel(item: NoteItem): string {
  const date = item.date.replaceAll("-", "/");
  return [date, item.time].filter(Boolean).join(" ");
}

export function itemTitle(item: Item): string {
  return item.kind === "timeline" ? firstLine(item.text) || untitled() : item.title;
}
