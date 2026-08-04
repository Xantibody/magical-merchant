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

/** リストペインの日付グループ見出し。「今日 — 8/4」 */
export function formatDayLabel(iso: string, today: Date): string {
  const date = parseIsoDate(iso);
  if (!date) {
    return iso;
  }
  const short = `${date.getMonth() + 1}/${date.getDate()}`;
  const diff = daysBetween(date, today);
  if (diff === 0) {
    return `今日 — ${short}`;
  }
  if (diff === 1) {
    return `昨日 — ${short}`;
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
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
