import type { Version } from "./commands";

/**
 * The message of the version core commits just before a restore. It is a fixed spelling
 * written into the file, so it is translated only when it is displayed.
 */
const BEFORE_RESTORE = "before restore";

export interface VersionRow {
  version: Version;
  /** The version number. The oldest version is 1. */
  number: number;
  /** The byte difference from the version one older. For the oldest it is the difference from 0, that is, its size. */
  delta: number;
}

/** Attach a number, and the size difference from the neighbour (the version one older), to versions in newest-first order. */
export function withDeltas(versions: readonly Version[]): VersionRow[] {
  return versions.map((version, index) => ({
    version,
    number: versions.length - index,
    delta: version.bytes - (versions[index + 1]?.bytes ?? 0),
  }));
}

/** Whether it is the "before restore" version. Of the rows on the spine, only this one names itself that instead of carrying a date. */
export function isBeforeRestore(version: Version): boolean {
  return version.message === BEFORE_RESTORE;
}

/** The version's date, "09/10". time is sliced as the local time where it was written (the same as `note-meta.ts`). */
export function versionDay(version: Version): string {
  return version.time.slice(5, 10).replace("-", "/");
}

/** The version's time, "09:12". */
export function versionClock(version: Version): string {
  return version.time.slice(11, 16);
}

/** The number of whole days from `time` to `now`. 0 means today. */
export function daysSince(time: string, now: Date): number {
  const then = new Date(time).getTime();
  if (Number.isNaN(then)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * The span in "committed 4 times over 9 months". If not one month is full, it counts in
 * days. Months are counted by the calendar: 31 January to 28 February is 0 months.
 */
export interface Span {
  months: number;
  days: number;
}

export function spanSince(time: string, now: Date): Span {
  const then = new Date(time);
  if (Number.isNaN(then.getTime())) {
    return { months: 0, days: 0 };
  }
  let months = (now.getFullYear() - then.getFullYear()) * 12 + now.getMonth() - then.getMonth();
  if (now.getDate() < then.getDate()) {
    months -= 1;
  }
  return { months: Math.max(0, months), days: daysSince(time, now) };
}

/** The one line shown on the row. Empty if there is none. Only "before restore" is core's fixed spelling, so it is translated. */
export function versionMessage(version: Version, beforeRestore: string): string {
  if (version.message === BEFORE_RESTORE) {
    return beforeRestore;
  }
  return version.message ?? "";
}
