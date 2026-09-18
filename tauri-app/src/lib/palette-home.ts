/**
 * パレットの zero-query 状態(何も打っていないとき)に出す入り口。
 *
 * どれも既にある IPC(list_notes / list_timeline_dates)から導出するだけで、
 * 新しいコマンドは増やさない。行は既存の SearchHit の形に寄せて、選んだ
 * ときの着地を検索ヒットと同じ経路に流す。
 */

import type { SearchHit } from "./commands";
import { toIsoDate } from "./day-labels";
import { t } from "./i18n";
import type { NoteItem } from "./items";
import { countTagLists } from "./tags";
import type { TagCount } from "./tags";

const RECENT_LIMIT = 5;

function noteHit(item: NoteItem): SearchHit {
  return {
    kind: item.kind,
    title: item.title,
    snippet: "",
    date: item.date,
    filename: item.filename,
    index: null,
    tags: item.tags,
  };
}

/** 一覧の先頭 = 最近のノート。開く行にして返す。 */
export function recentNoteHits(items: NoteItem[]): SearchHit[] {
  return items.slice(0, RECENT_LIMIT).map((item) => noteHit(item));
}

/**
 * ノートに付いたタグを数える。多い順。
 *
 * 数え方は本文の `#タグ` と同じ(`tags.ts`)。生の綴りで数えると `Memo` と
 * `memo` が別の行になり、同じ分類を件数ごと押し分けることになる。
 */
export function countNoteTags(items: NoteItem[]): TagCount[] {
  return countTagLists(items.map((item) => item.tags));
}

export interface DayJump {
  label: string;
  hit: SearchHit;
}

/** 今日・昨日への入り口。記録のある日だけ出す — 空の日に着地させない。 */
export function dayJumpHits(recordedDates: string[], today: Date): DayJump[] {
  const dates = new Set(recordedDates);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const candidates: [string, string][] = [
    [t().day.today, toIsoDate(today)],
    [t().day.yesterday, toIsoDate(yesterday)],
  ];
  return candidates
    .filter(([, iso]) => dates.has(iso))
    .map(([label, iso]) => ({
      label,
      hit: {
        kind: "timeline",
        title: label,
        snippet: "",
        date: iso,
        filename: null,
        index: null,
        tags: [],
      },
    }));
}
