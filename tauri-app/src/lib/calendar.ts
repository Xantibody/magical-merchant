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
  places: Tally[];
  devices: Tally[];
}

const UNKNOWN_PLACE = "場所不明";

function placeOf(context: DeviceContext | null): string | null {
  if (!context) {
    return null;
  }
  if (context.wifi_ssid) {
    return context.wifi_ssid;
  }
  if (context.location) {
    return UNKNOWN_PLACE;
  }
  return null;
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
 * その日のエントリを場所と端末で数える。場所の名前は Wi-Fi SSID を使う:
 * 記録に含まれる中で人が地名として読める唯一の値がこれしかない。
 */
export function summarizeDay(contexts: (DeviceContext | null)[]): DaySummary {
  return {
    count: contexts.length,
    places: tally(contexts.map((c) => placeOf(c))),
    devices: tally(contexts.map((c) => c?.os || null)),
  };
}
