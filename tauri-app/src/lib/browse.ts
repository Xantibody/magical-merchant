/**
 * 「絞る」画面の勘定。種類 / タグ / 期間の 3 軸と、軸ごとの件数。
 *
 * 絞り込みを core に持たせていないのは、チップに出す件数が「他の軸を掛けた
 * うえでの件数」で、軸ごとに母集団が違うから — 種類の数字はタグと期間だけを
 * 掛けた母集団から、タグの数字は種類と期間だけを掛けた母集団から出る。
 * core に持たせると facet プロトコルを 1 つ発明することになるので、
 * `browse_all` は全件を 1 回返すだけにして、数えるのはここでやる(#279)。
 *
 * ここは画面を描かない純粋な関数だけ。日付は引数で受ける — `new Date()` を
 * 中で読むと、境目をまたぐ瞬間にしか再現しないテストになる。
 */

import type { HitKind, SearchHit } from "./commands";
import { toIsoDate } from "./day-labels";
import { countTagLists, sameTag } from "./tags";
import { digestWeekKey } from "./weekly-digest";

/** 期間の軸。3 択で、既定は「すべて」。 */
export type BrowsePeriod = "all" | "month" | "week";

/** 期間のチップの並び。広いほうから狭いほうへ。 */
export const BROWSE_PERIODS: readonly BrowsePeriod[] = ["all", "month", "week"];

/** 種類のチップの並び。プロトタイプと同じ CODEX → NOTE → SCRAWL。 */
export const BROWSE_KINDS: readonly HitKind[] = ["codex", "note", "scrawl"];

export interface BrowseFilter {
  /** 選んだ種類。空なら全部。複数選べて、どれかに当たれば残る。 */
  kinds: HitKind[];
  /** 選んだタグ。空なら全部。種類と同じくどれかに当たれば残る。 */
  tags: string[];
  period: BrowsePeriod;
}

/** 何も絞っていない状態。 */
export const NO_FILTER: BrowseFilter = { kinds: [], tags: [], period: "all" };

export function hasFilter(filter: BrowseFilter): boolean {
  return filter.kinds.length > 0 || filter.tags.length > 0 || filter.period !== "all";
}

/**
 * 一覧の行を指す鍵。ノートはファイル名(不変の ID)、Scrawl の 1 行は
 * ファイルを持たないので日と行位置の組。
 */
export function hitId(hit: SearchHit): string {
  return hit.kind === "scrawl" ? `${hit.date}#${hit.index ?? 0}` : (hit.filename ?? hit.date);
}

/**
 * 期間の下限。この日以降が残る。「すべて」は境目を持たない。
 *
 * 週の起点は月曜で、Scrawl の週次ダイジェスト(`weekly-digest.ts`)と同じ数え方。
 * 別に数えると、同じ「今週」が画面ごとに違う件数を出す。
 */
export function periodStart(period: BrowsePeriod, today: Date): string | null {
  if (period === "all") {
    return null;
  }
  if (period === "week") {
    return digestWeekKey(today);
  }
  return toIsoDate(new Date(today.getFullYear(), today.getMonth(), 1));
}

/**
 * 期間に入っているか。`date` が空なのは frontmatter に time を持たない
 * ノートで、期間を選んだら数えようがないので外す。「すべて」では出す。
 */
function inPeriod(hit: SearchHit, start: string | null): boolean {
  return start === null || (hit.date !== "" && hit.date >= start);
}

function inKinds(hit: SearchHit, kinds: readonly HitKind[]): boolean {
  return kinds.length === 0 || kinds.includes(hit.kind);
}

/** 綴りの違いは見ない。チップに出るのは代表の 1 つだけなので(`tags.ts`)。 */
function inTags(hit: SearchHit, tags: readonly string[]): boolean {
  return tags.length === 0 || tags.some((tag) => hit.tags.some((own) => sameTag(own, tag)));
}

/** 3 軸を全部掛けた結果。並びは受け取った順(core が並べた新しい順)のまま。 */
export function filterHits(
  hits: readonly SearchHit[],
  filter: BrowseFilter,
  today: Date,
): SearchHit[] {
  const start = periodStart(filter.period, today);
  return hits.filter(
    (hit) => inPeriod(hit, start) && inKinds(hit, filter.kinds) && inTags(hit, filter.tags),
  );
}

/** チップ 1 つぶんの「押したら何件になるか」。 */
export interface Facet<T> {
  value: T;
  count: number;
}

/**
 * 種類の件数。母集団にタグと期間は掛けるが、種類の選択は掛けない —
 * 掛けると、いま選んでいない種類が必ず 0 件になって選び直せない。
 */
export function kindFacets(
  hits: readonly SearchHit[],
  filter: BrowseFilter,
  today: Date,
): Facet<HitKind>[] {
  const base = filterHits(hits, { ...filter, kinds: [] }, today);
  return BROWSE_KINDS.map((kind) => ({
    value: kind,
    count: base.filter((hit) => hit.kind === kind).length,
  }));
}

/**
 * チップに出すタグを、よく使う順に。数えるのは絞り込む前の全件 — 押すたびに
 * 並びが変わると、隣のチップを押すつもりで別のタグを押すことになる。
 * 綴りは最初に見たものが代表(`tags.ts` の畳み方)。
 */
export function chipTags(hits: readonly SearchHit[]): string[] {
  return countTagLists(hits.map((hit) => hit.tags)).map((counted) => counted.tag);
}

/**
 * タグの件数。種類の facet と対で、母集団に種類と期間は掛けるがタグの選択は
 * 掛けない。他の軸が空にしたタグも 0 件で残す — チップを消すと、押した先で
 * 行が入れ替わって次に押す物が変わる。
 */
export function tagFacets(
  hits: readonly SearchHit[],
  filter: BrowseFilter,
  today: Date,
): Facet<string>[] {
  const base = filterHits(hits, { ...filter, tags: [] }, today);
  return chipTags(hits).map((tag) => ({
    value: tag,
    count: base.filter((hit) => inTags(hit, [tag])).length,
  }));
}

export function toggleKind(kinds: readonly HitKind[], kind: HitKind): HitKind[] {
  return kinds.includes(kind) ? kinds.filter((own) => own !== kind) : [...kinds, kind];
}

/** 外すときも同一性で見る。完全一致だと、綴りの違うタグが押しても外れない。 */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  return tags.some((own) => sameTag(own, tag))
    ? tags.filter((own) => !sameTag(own, tag))
    : [...tags, tag];
}
