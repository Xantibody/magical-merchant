/**
 * Material for the review card shown once a week at the top of Scrawl.
 *
 * Everything is aggregated from the already loaded Scrawl and the date list;
 * nothing is written to core or to the data files. Only the dismissal is kept
 * locally on the device (localStorage): which device dismissed it is of no
 * concern to the other devices.
 */

import { toIsoDate } from "./day-labels";
import type { ScrawlItem } from "./items";

/** A week's identity is Monday's date. Used to compare the dismissed week with the current one. */
export function digestWeekKey(today: Date): string {
  // getDay(): Sunday is 0. Map it to a Monday start
  const sinceMonday = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - sinceMonday);
  return toIsoDate(monday);
}

/** Not shown if dismissed this week. Shown again once the week changes. */
export function isDigestDismissed(stored: string | null, today: Date): boolean {
  return stored === digestWeekKey(today);
}

export interface WeekSummary {
  /** Entries this week. */
  count: number;
  /** Days that have a record. */
  days: number;
}

/** Counts only the entries of this week (Monday start). */
export function summarizeWeek(items: ScrawlItem[], today: Date): WeekSummary {
  const start = digestWeekKey(today);
  const week = items.filter((item) => item.date >= start && item.date <= toIsoDate(today));
  return {
    count: week.length,
    days: new Set(week.map((item) => item.date)).size,
  };
}

/** The same date a year back. A 29 February lands on 1 March, which is what Date does with it. */
export function yearAgoDate(today: Date): string {
  return toIsoDate(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
}

/** Today one year ago. null when that day has no record, as there is nowhere to land. */
export function yearAgoToday(today: Date, recordedDates: string[]): string | null {
  const target = yearAgoDate(today);
  return recordedDates.includes(target) ? target : null;
}
