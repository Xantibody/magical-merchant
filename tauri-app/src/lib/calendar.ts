import type { DeviceContext } from "./parse-timeline";

export interface MonthCell {
  date: Date;
  iso: string;
  day: number;
  inMonth: boolean;
}

export const WEEKDAY_LABELS = ["月", "火", "水", "木", "金", "土", "日"] as const;

const DAYS_IN_GRID = 42;

function isoOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 月曜始まりの 6 週グリッド。行数を固定しないとポップオーバーの高さが月ごとに
 * 跳ねる。
 */
export function buildMonthGrid(year: number, month: number): MonthCell[] {
  const first = new Date(year, month, 1);
  // getDay() は日曜が 0。月曜始まりに直す
  const leading = (first.getDay() + 6) % 7;

  return Array.from({ length: DAYS_IN_GRID }, (_, i) => {
    const date = new Date(year, month, 1 - leading + i);
    return {
      date,
      iso: isoOf(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month,
    };
  });
}

export function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const shifted = new Date(year, month + delta, 1);
  return [shifted.getFullYear(), shifted.getMonth()];
}

export function formatMonthTitle(year: number, month: number): string {
  return `${year}年${month + 1}月`;
}

interface Tally {
  label: string;
  count: number;
}

export interface DaySummary {
  count: number;
  /** 座標が残っているエントリの数。 */
  located: number;
  /** ラベルは `NetworkType` そのもの。アイコンに直すのは表示側の仕事。 */
  networks: Tally[];
  devices: Tally[];
}

function tally(values: (string | null)[]): Tally[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * その日のエントリを回線と端末で数える。
 *
 * 場所は座標があるかどうかだけを数える。緯度経度をそのまま並べても地名には
 * ならず、数えて意味が出るのは「その日どれだけ外で書いたか」のほう。
 */
export function summarizeDay(contexts: (DeviceContext | null)[]): DaySummary {
  return {
    count: contexts.length,
    located: contexts.filter((c) => c?.location).length,
    networks: tally(contexts.map((c) => c?.network_type ?? null)),
    devices: tally(contexts.map((c) => c?.os || null)),
  };
}
