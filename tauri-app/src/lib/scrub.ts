/**
 * The arithmetic of the thumb at Scrawl's right edge (22). The track stands for every day that
 * has a record, newest at the top, one step per day: a busy month takes more of the track than
 * a quiet one, which is where a finger wants the room.
 */

/** The day under a point of the track, `fraction` 0 at the top to 1 at the bottom. */
export function scrubIndex(fraction: number, days: number): number {
  if (days <= 1) {
    return 0;
  }
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * (days - 1));
}

export interface YearMark {
  year: string;
  /** Where along the track the year's newest day sits. */
  fraction: number;
}

/**
 * Where each year begins along the track, read from the newest down. The current year is left
 * out: it is the top of the track, and a label there would sit on the thumb at rest.
 */
export function scrubYears(dates: readonly string[]): YearMark[] {
  if (dates.length < 2) {
    return [];
  }
  const marks: YearMark[] = [];
  let previous = dates[0]?.slice(0, 4);
  dates.forEach((date, i) => {
    const year = date.slice(0, 4);
    if (year !== previous) {
      marks.push({ year, fraction: i / (dates.length - 1) });
      previous = year;
    }
  });
  return marks;
}
