import type { Version } from "./commands";

/**
 * 戻す直前に core が刻む版の message。ファイルに書かれる固定の綴りなので、
 * 表示するときだけ訳す。
 */
const BEFORE_RESTORE = "before restore";

export interface VersionRow {
  version: Version;
  /** 1 つ古い版とのバイト差。いちばん古い版は 0 からの差、つまり大きさそのもの。 */
  delta: number;
}

/** 新しい順の版に、隣(1 つ古い版)との大きさの差を添える。 */
export function withDeltas(versions: readonly Version[]): VersionRow[] {
  return versions.map((version, index) => ({
    version,
    delta: version.bytes - (versions[index + 1]?.bytes ?? 0),
  }));
}

/** 行に出す一言。無ければ空。「戻す前」だけは core の固定綴りなので訳す。 */
export function versionMessage(version: Version, beforeRestore: string): string {
  if (version.message === BEFORE_RESTORE) {
    return beforeRestore;
  }
  return version.message ?? "";
}
