import { t } from "./i18n";
import type { DeviceContext } from "./parse-scrawl";

export interface MonthCell {
  date: Date;
  iso: string;
  day: number;
  inMonth: boolean;
}

/** The weekday headings. The week is fixed to start on Monday. */
export function weekdayLabels(): readonly string[] {
  return t().calendar.weekdays;
}

const DAYS_IN_GRID = 42;

function isoOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A 6-week grid starting on Monday. Without a fixed row count the popover height jumps
 * from month to month.
 */
export function buildMonthGrid(year: number, month: number): MonthCell[] {
  const first = new Date(year, month, 1);
  // getDay() has Sunday as 0. Shift it to start on Monday
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
  return t().calendar.monthTitle(year, month);
}

interface Tally {
  label: string;
  count: number;
}

export interface DaySummary {
  count: number;
  /** The number of entries that still carry coordinates. */
  located: number;
  /** The label is the `NetworkType` itself. Turning it into an icon is the view's job. */
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
 * Count the day's entries by network and device.
 *
 * For location, only whether coordinates exist is counted. Listing raw latitude and
 * longitude does not make a place name, and what is worth counting is "how much was
 * written outside that day".
 */
export function summarizeDay(contexts: (DeviceContext | null)[]): DaySummary {
  return {
    count: contexts.length,
    located: contexts.filter((c) => c?.location).length,
    networks: tally(contexts.map((c) => c?.network_type ?? null)),
    devices: tally(contexts.map((c) => c?.os || null)),
  };
}
