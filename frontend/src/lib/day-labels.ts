import { t } from "./i18n";

/** Reads `YYYY-MM-DD` as a local date, not UTC. */
export function parseIsoDate(iso: string): Date | null {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(iso);
  if (!match) {
    return null;
  }
  const { year, month, day } = match.groups ?? {};
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Difference in calendar days. The time of day is ignored. */
export function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Heading of a day group. Returns the heading word and the date placed under it separately. */
export function formatDayHeading(iso: string, today: Date): { label: string; date: string } {
  const date = parseIsoDate(iso);
  if (!date) {
    return { label: iso, date: "" };
  }
  const day = t().day.monthDay(date.getMonth() + 1, date.getDate());
  const weekday = t().day.weekdays[date.getDay()];
  const diff = daysBetween(date, today);

  if (diff === 0) {
    return { label: t().day.today, date: `${day} ${weekday}` };
  }
  if (diff === 1) {
    return { label: t().day.yesterday, date: `${day} ${weekday}` };
  }
  // From here on "N days ago" needs counting to understand. Promote the date to the heading.
  return { label: day, date: weekday };
}

/** Clock reading. "21:40" */
export function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Short date on the second line of lists and search results. "08/04" */
export function formatMonthDay(iso: string): string {
  return iso.slice(5).replace("-", "/");
}

export function formatNoteGroupLabel(iso: string, today: Date): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return t().day.noDate;
  }
  const diff = daysBetween(date, today);
  if (diff === 0) {
    return t().day.today;
  }
  // A note dated in the future (device clock off, or placed there on purpose)
  // is folded into this week. Calling it "today" would be a lie
  if (diff < 7) {
    return t().day.thisWeek;
  }
  if (diff < 14) {
    return t().day.lastWeek;
  }
  return t().day.earlier;
}
