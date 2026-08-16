/**
 * タイムライン先頭に週 1 回だけ出すふりかえりカードの材料。
 *
 * すべて読み込み済みのタイムラインと日付一覧からの集計で、core にも
 * データファイルにも何も書かない。閉じた記録だけを端末ローカル
 * (localStorage)に持つ — どの端末で閉じたかは他の端末に関係ない。
 */

import { toIsoDate } from "./day-labels";
import type { TimelineItem } from "./items";
import { countTags } from "./tags";
import type { TagCount } from "./tags";

const TOP_TAGS = 3;

/** 週の身元は月曜の日付。閉じた週と今の週の比較に使う。 */
export function digestWeekKey(today: Date): string {
  // getDay(): 日曜 0。月曜起点に写像する
  const sinceMonday = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - sinceMonday);
  return toIsoDate(monday);
}

/** 閉じたのが今週なら出さない。週が変われば出し直す。 */
export function isDigestDismissed(stored: string | null, today: Date): boolean {
  return stored === digestWeekKey(today);
}

export interface WeekSummary {
  /** 今週のエントリ数。 */
  count: number;
  /** 記録のあった日数。 */
  days: number;
  topTags: TagCount[];
}

/** 今週(月曜起点)のエントリだけを数える。 */
export function summarizeWeek(items: TimelineItem[], today: Date): WeekSummary {
  const start = digestWeekKey(today);
  const week = items.filter((item) => item.date >= start && item.date <= toIsoDate(today));
  return {
    count: week.length,
    days: new Set(week.map((item) => item.date)).size,
    topTags: countTags(week.map((item) => item.text)).slice(0, TOP_TAGS),
  };
}

/** 1 年前の今日。記録が無い日は出しても着地する先がないので null。 */
export function yearAgoToday(today: Date, recordedDates: string[]): string | null {
  const target = toIsoDate(new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()));
  return recordedDates.includes(target) ? target : null;
}
