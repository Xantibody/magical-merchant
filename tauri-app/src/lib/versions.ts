import type { Version } from "./commands";

/**
 * 戻す直前に core が刻む版の message。ファイルに書かれる固定の綴りなので、
 * 表示するときだけ訳す。
 */
const BEFORE_RESTORE = "before restore";

export interface VersionRow {
  version: Version;
  /** 版の番号。いちばん古い版が 1。 */
  number: number;
  /** 1 つ古い版とのバイト差。いちばん古い版は 0 からの差、つまり大きさそのもの。 */
  delta: number;
}

/** 新しい順の版に、番号と、隣(1 つ古い版)との大きさの差を添える。 */
export function withDeltas(versions: readonly Version[]): VersionRow[] {
  return versions.map((version, index) => ({
    version,
    number: versions.length - index,
    delta: version.bytes - (versions[index + 1]?.bytes ?? 0),
  }));
}

/** 「戻す前」の版か。背骨の行はこれだけ日付の代わりにそう名乗る。 */
export function isBeforeRestore(version: Version): boolean {
  return version.message === BEFORE_RESTORE;
}

/** 版の日付「09/10」。time は書いた土地の時刻のまま切り出す(`note-meta.ts` と同じ)。 */
export function versionDay(version: Version): string {
  return version.time.slice(5, 10).replace("-", "/");
}

/** 版の時刻「09:12」。 */
export function versionClock(version: Version): string {
  return version.time.slice(11, 16);
}

/** `time` から `now` までの丸 1 日の数。0 なら今日。 */
export function daysSince(time: string, now: Date): number {
  const then = new Date(time).getTime();
  if (Number.isNaN(then)) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
}

/**
 * 「9 か月で 4 回刻んだ」の期間。月が 1 つも満ちていなければ日で数える。
 * 月は暦で数える — 1 月 31 日から 2 月 28 日は 0 か月。
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

/** 行に出す一言。無ければ空。「戻す前」だけは core の固定綴りなので訳す。 */
export function versionMessage(version: Version, beforeRestore: string): string {
  if (version.message === BEFORE_RESTORE) {
    return beforeRestore;
  }
  return version.message ?? "";
}
