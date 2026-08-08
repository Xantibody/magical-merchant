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

const WEEKDAYS = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];

/** 日グループの見出し。見出し語と、その下に添える日付に分けて返す。 */
export function formatDayHeading(iso: string, today: Date): { label: string; date: string } {
  const date = parseIsoDate(iso);
  if (!date) {
    return { label: iso, date: "" };
  }
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  const weekday = WEEKDAYS[date.getDay()];
  const diff = daysBetween(date, today);

  if (diff === 0) {
    return { label: "今日", date: `${day} ${weekday}` };
  }
  if (diff === 1) {
    return { label: "昨日", date: `${day} ${weekday}` };
  }
  // ここまで来ると「N 日前」は数えないと分からない。日付を見出しに上げる。
  return { label: day, date: weekday };
}

/** Notes のグループ見出し。「今週 / 先週 / それ以前」 */
export function formatNoteGroupLabel(iso: string, today: Date): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return "日付なし";
  }
  const diff = daysBetween(date, today);
  if (diff < 0) {
    return "今週";
  }
  if (diff < 7) {
    return "今週";
  }
  if (diff < 14) {
    return "先週";
  }
  return "それ以前";
}

/** 詳細ペインのメタバー。「2026-08-04 15:27」 */
export function formatDateTime(iso: string, time: string): string {
  return time ? `${iso} ${time.slice(0, 5)}` : iso;
}
