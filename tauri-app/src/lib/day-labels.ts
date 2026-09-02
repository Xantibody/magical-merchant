import { t } from "./i18n";

/** `YYYY-MM-DD` を UTC ではなくローカル日付として読む。 */
export function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 暦日の差。時刻は無視する。 */
export function daysBetween(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** 日グループの見出し。見出し語と、その下に添える日付に分けて返す。 */
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
  // ここまで来ると「N 日前」は数えないと分からない。日付を見出しに上げる。
  return { label: day, date: weekday };
}

/** Notes のグループ見出し。「今週 / 先週 / それ以前」 */
/** 一覧・検索結果の 2 段目に出す短い日付。「08/04」 */
export function formatMonthDay(iso: string): string {
  return iso.slice(5).replace("-", "/");
}

export function formatNoteGroupLabel(iso: string, today: Date): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return t().day.noDate;
  }
  const diff = daysBetween(date, today);
  if (diff < 0) {
    return t().day.thisWeek;
  }
  if (diff < 7) {
    return t().day.thisWeek;
  }
  if (diff < 14) {
    return t().day.lastWeek;
  }
  return t().day.earlier;
}
