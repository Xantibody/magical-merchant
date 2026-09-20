import { describe, it, expect } from "vitest";
import {
  NO_FILTER,
  chipTags,
  filterHits,
  hasFilter,
  hitId,
  kindFacets,
  periodStart,
  tagFacets,
  toggleKind,
  toggleTag,
} from "./browse";
import type { HitKind, SearchHit } from "./commands";

const pad = (value: number): string => String(value).padStart(2, "0");
const isoOf = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * 今日を固定で書ける。境目を数えるのは `today` を引数で受ける関数だけなので、
 * 走らせた日でテストが揺れない — カレンダー次第で落ちるのは、日付を中で
 * 読む実装のほうだった。9/20 は日曜で、月曜起点の週の 7 日目。
 */
const TODAY = new Date(2026, 8, 20);
const TODAY_ISO = isoOf(TODAY);
const daysAgo = (back: number): string =>
  isoOf(new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - back));

function hit(kind: HitKind, date: string, tags: string[] = [], title = "題"): SearchHit {
  return {
    kind,
    title,
    snippet: "本文の先頭",
    date,
    filename: kind === "scrawl" ? null : `${date.replaceAll("-", "")}_120000.md`,
    index: kind === "scrawl" ? 0 : null,
    tags,
    match_start: null,
    match_len: null,
  };
}

describe("hitId", () => {
  it("names a note by its filename, the immutable ID", () => {
    expect(hitId(hit("note", "2026-09-20"))).toBe("20260920_120000.md");
  });

  // Scrawl の 1 行はファイルを持たない。日と行位置の組だけが行を指す
  it("names a scrawl entry by its day and line", () => {
    const entry = { ...hit("scrawl", "2026-09-20"), index: 3 };
    expect(hitId(entry)).toBe("2026-09-20#3");
  });
});

describe("periodStart", () => {
  it("has no boundary for all", () => {
    expect(periodStart("all", TODAY)).toBeNull();
  });

  it("starts the month on its first day", () => {
    expect(periodStart("month", TODAY)).toBe("2026-09-01");
  });

  // 週の起点は月曜。Scrawl の週次ダイジェストと同じ数え方でなければ、
  // 同じ「今週」が画面ごとに違う件数を出す
  it("starts the week on monday", () => {
    expect(periodStart("week", new Date(2026, 8, 20))).toBe("2026-09-14");
    expect(periodStart("week", new Date(2026, 8, 14))).toBe("2026-09-14");
  });
});

describe("filterHits", () => {
  const hits = [
    hit("scrawl", TODAY_ISO, ["run"]),
    hit("note", daysAgo(10), ["design", "perf"]),
    hit("codex", daysAgo(60), ["design"]),
  ];

  it("keeps everything when nothing is chosen", () => {
    expect(filterHits(hits, NO_FILTER, TODAY)).toHaveLength(3);
  });

  it("keeps the order it was given", () => {
    expect(filterHits(hits, NO_FILTER, TODAY).map((h) => h.date)).toStrictEqual([
      TODAY_ISO,
      daysAgo(10),
      daysAgo(60),
    ]);
  });

  // 軸の中は OR。2 つ選ぶのは「どちらも見たい」であって、両方を兼ねる
  // 記録を探すことではない
  it("keeps a hit matching any chosen kind", () => {
    const kept = filterHits(hits, { ...NO_FILTER, kinds: ["scrawl", "codex"] }, TODAY);
    expect(kept.map((h) => h.kind)).toStrictEqual(["scrawl", "codex"]);
  });

  it("keeps a hit carrying any chosen tag", () => {
    const kept = filterHits(hits, { ...NO_FILTER, tags: ["perf", "run"] }, TODAY);
    expect(kept.map((h) => h.kind)).toStrictEqual(["scrawl", "note"]);
  });

  // チップの綴りは代表の 1 つだけ。大小違いで書かれた記録が落ちると、
  // チップの件数と一覧が食い違う
  it("matches a tag however it was spelled", () => {
    const mixed = [hit("note", TODAY_ISO, ["Memo"])];
    expect(filterHits(mixed, { ...NO_FILTER, tags: ["memo"] }, TODAY)).toHaveLength(1);
  });

  it("drops what falls outside the period", () => {
    const kept = filterHits(hits, { ...NO_FILTER, period: "month" }, TODAY);
    expect(kept.map((h) => h.date)).toStrictEqual([TODAY_ISO, daysAgo(10)]);
  });

  it("crosses the three axes", () => {
    const kept = filterHits(hits, { kinds: ["note"], tags: ["design"], period: "month" }, TODAY);
    expect(kept.map((h) => h.date)).toStrictEqual([daysAgo(10)]);
  });

  // time を持たないノートは日付が空で届く。期間を選んだら数えようがないので
  // 外し、「すべて」では出す — 消えたままにはしない
  it("keeps a dateless note only while the period is all", () => {
    const dateless = [hit("note", "")];
    expect(filterHits(dateless, NO_FILTER, TODAY)).toHaveLength(1);
    expect(filterHits(dateless, { ...NO_FILTER, period: "month" }, TODAY)).toHaveLength(0);
  });
});

describe("kindFacets", () => {
  const hits = [
    hit("scrawl", TODAY_ISO, ["run"]),
    hit("scrawl", daysAgo(60), ["design"]),
    hit("note", TODAY_ISO, ["design"]),
    hit("codex", TODAY_ISO, ["design"]),
  ];

  it("lists the three kinds in the same order every time", () => {
    expect(kindFacets(hits, NO_FILTER, TODAY).map((f) => f.value)).toStrictEqual([
      "codex",
      "note",
      "scrawl",
    ]);
  });

  it("counts every kind when nothing is chosen", () => {
    expect(kindFacets(hits, NO_FILTER, TODAY).map((f) => f.count)).toStrictEqual([1, 1, 2]);
  });

  // 種類の件数は「その種類を選んだら何件になるか」。自分の軸の選択は
  // 母集団に掛けない — 掛けると、選んでいない種類が必ず 0 件になる
  it("ignores the kind already chosen", () => {
    const facets = kindFacets(hits, { ...NO_FILTER, kinds: ["note"] }, TODAY);
    expect(facets.map((f) => f.count)).toStrictEqual([1, 1, 2]);
  });

  it("applies the other axes", () => {
    const facets = kindFacets(hits, { ...NO_FILTER, tags: ["design"] }, TODAY);
    expect(facets.map((f) => f.count)).toStrictEqual([1, 1, 1]);
    const thisMonth = kindFacets(hits, { ...NO_FILTER, period: "month" }, TODAY);
    expect(thisMonth.map((f) => f.count)).toStrictEqual([1, 1, 1]);
  });
});

describe("chipTags", () => {
  it("puts the most used tag first and keeps the spelling it met first", () => {
    const hits = [
      hit("note", TODAY_ISO, ["Memo"]),
      hit("note", TODAY_ISO, ["memo"]),
      hit("scrawl", TODAY_ISO, ["run"]),
    ];
    expect(chipTags(hits)).toStrictEqual(["Memo", "run"]);
  });

  // チップの並びは絞り込みで動かさない。押すたびに行が入れ替わると、
  // 隣のチップを押すつもりで別のタグを押す
  it("names every tag in the corpus, filter or not", () => {
    const hits = [hit("note", TODAY_ISO, ["design"]), hit("scrawl", daysAgo(60), ["run"])];
    expect(chipTags(hits)).toStrictEqual(["design", "run"]);
  });
});

describe("tagFacets", () => {
  const hits = [
    hit("note", TODAY_ISO, ["design"]),
    hit("codex", TODAY_ISO, ["design"]),
    hit("scrawl", daysAgo(60), ["run"]),
  ];

  it("counts each tag over the whole corpus when nothing is chosen", () => {
    expect(tagFacets(hits, NO_FILTER, TODAY)).toStrictEqual([
      { value: "design", count: 2 },
      { value: "run", count: 1 },
    ]);
  });

  it("ignores the tags already chosen but applies the other axes", () => {
    const facets = tagFacets(hits, { ...NO_FILTER, tags: ["design"], kinds: ["note"] }, TODAY);
    expect(facets).toStrictEqual([
      { value: "design", count: 1 },
      { value: "run", count: 0 },
    ]);
  });

  // 0 件のチップも残す。消すと、押した先で行が入れ替わって次に押す物が変わる
  it("keeps a tag that the other axes have emptied", () => {
    const facets = tagFacets(hits, { ...NO_FILTER, period: "month" }, TODAY);
    expect(facets).toStrictEqual([
      { value: "design", count: 2 },
      { value: "run", count: 0 },
    ]);
  });
});

describe("hasFilter", () => {
  it("is false only when all three axes are untouched", () => {
    expect(hasFilter(NO_FILTER)).toBe(false);
    expect(hasFilter({ ...NO_FILTER, kinds: ["note"] })).toBe(true);
    expect(hasFilter({ ...NO_FILTER, tags: ["run"] })).toBe(true);
    expect(hasFilter({ ...NO_FILTER, period: "week" })).toBe(true);
  });
});

describe("toggleKind / toggleTag", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleKind([], "note")).toStrictEqual(["note"]);
    expect(toggleKind(["note", "codex"], "note")).toStrictEqual(["codex"]);
  });

  // 外すときも同一性で見る。完全一致だと、選んだ綴りとチップの綴りが
  // 違うタグは押しても外れない
  it("removes a tag whatever the spelling", () => {
    expect(toggleTag(["Memo"], "memo")).toStrictEqual([]);
    expect(toggleTag([], "memo")).toStrictEqual(["memo"]);
  });
});
