import type { Note } from "./commands";
import { daysBetween, formatMonthDay, formatNoteGroupLabel, parseIsoDate } from "./day-labels";
import { t } from "./i18n";
import { resolveNoteView } from "./note-view";
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
  /** 昇格元エントリの日時。タイムラインのチップ表示が使う。 */
  origin?: string;
  /** 読み取り専用にしたノート。一覧が鍵を出す。 */
  readOnly: boolean;
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
  return line?.replace(/^#+\s*/u, "").trim() ?? "";
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
    readOnly: resolveNoteView(note.view) === "preview",
  }));
}

/** エントリを origin の書式（`YYYY-MM-DDTHH:MM:SS`）で指す鍵。昇格時と同じ組み立て。 */
export function originKeyOf(item: TimelineItem): string {
  return `${item.date}T${item.time}`;
}

/**
 * 昇格ノートを origin の日時そのもので引けるようにする。エントリ側の
 * `originKeyOf` と同じ文字列が鍵なので、チップを元のエントリの真下に
 * 出せる — エントリ側のファイルには何も書いていないので、並び替えや
 * 行の増減でズレる心配がない。
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
 * 昇格元のエントリがもう見つからないノートを、origin の暦日でまとめる。
 * エントリを消してもノートは残るので、その入り口が消えないよう日の見出し
 * 直下に避難させる。突き合わせるのは絞り込み前の全エントリ — タグで
 * 隠れているだけのエントリを「消えた」と読むと、絞り込むたびに無関係な
 * チップが見出しへ湧いてしまう。
 */
export function orphanNotesByDate(
  notes: NoteItem[],
  items: TimelineItem[],
): Map<string, NoteItem[]> {
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

/**
 * 消したあとに選び直す隣の id。一覧で真上にあったものを優先し、先頭を
 * 消したときだけ真下へ落ちる。ノートは新しい順に並ぶので「上」は直近の
 * 記録 — 消した直後に目が向く先と同じ。残りがなければ null。
 */
export function neighborOf(items: readonly { id: string }[], id: string): string | null {
  const at = items.findIndex((item) => item.id === id);
  if (at === -1) {
    return null;
  }
  return items[at - 1]?.id ?? items[at + 1]?.id ?? null;
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

/**
 * 詳細ヘッダの作成日時。「2026/05/03 15:39」
 * ファイル名は同期やウィジェットが指す不変の ID であって、人に見せる
 * ものではない。人が読むのはこちら。
 */
export function noteCreatedLabel(item: NoteItem): string {
  const date = item.date.replaceAll("-", "/");
  return [date, item.time].filter(Boolean).join(" ");
}

/**
 * 一覧の行の右端に置く 1 つの値。今日のノートは時刻、それ以前は日付。
 * 今日のノートに「08/04」と出しても、見出しが既に言っていること以上は
 * 分からない — 時刻なら、さっき書いたどれなのかが読める。
 */
export function noteRowStamp(item: NoteItem, today: Date): string {
  const date = parseIsoDate(item.date);
  return date && daysBetween(date, today) === 0 ? item.time : formatMonthDay(item.date);
}

export function itemTitle(item: Item): string {
  return item.kind === "timeline" ? firstLine(item.text) || untitled() : item.title;
}
