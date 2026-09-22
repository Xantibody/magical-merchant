import { describe, it, expect } from "vitest";
import {
  NO_FILTER,
  browseSeed,
  chipTags,
  filterHits,
  hasFilter,
  hitId,
  kindFacets,
  periodStart,
  rowSnippet,
  tagFacets,
  toggleKind,
  toggleTag,
} from "./browse";
import type { HitKind, SearchHit } from "./commands";

const pad = (value: number): string => String(value).padStart(2, "0");
const isoOf = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Today can be written as a fixed value. Only functions that take `today` as an argument
 * count the boundaries, so the tests do not shift with the day they are run on: what used
 * to fail depending on the calendar was the implementation that read the date inside.
 * 2026-09-20 is a Sunday, the seventh day of a week that starts on Monday.
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

  // A Scrawl line has no file. Only the pair of day and line position points at it
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

  // The week starts on Monday. If it were not counted the same way as Scrawl's weekly
  // digest, the same "this week" would give a different count on each screen
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

  // Within an axis it is OR. Choosing two means "show me both", not looking for a record
  // that is both at once
  it("keeps a hit matching any chosen kind", () => {
    const kept = filterHits(hits, { ...NO_FILTER, kinds: ["scrawl", "codex"] }, TODAY);
    expect(kept.map((h) => h.kind)).toStrictEqual(["scrawl", "codex"]);
  });

  it("keeps a hit carrying any chosen tag", () => {
    const kept = filterHits(hits, { ...NO_FILTER, tags: ["perf", "run"] }, TODAY);
    expect(kept.map((h) => h.kind)).toStrictEqual(["scrawl", "note"]);
  });

  // A chip carries only one representative spelling. If records written with a different
  // case were dropped, the chip's count and the list would disagree
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

  // A note without a time arrives with an empty date. Once a period is chosen there is no
  // way to count it, so it is dropped; under "all" it is shown, never left missing
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

  // A kind's count answers "how many records if this kind were chosen". The selection on
  // its own axis is not applied to the population: if it were, every kind not chosen would
  // always be 0
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

  // The chip order does not move with the filter. If the row reshuffled on every press,
  // aiming at the neighbouring chip would hit a different tag
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

  // A chip at 0 stays. Removing it would reshuffle the row after a press and change what
  // is under the finger next
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

describe("rowSnippet", () => {
  const excerpt = (title: string, snippet: string): SearchHit => ({
    ...hit("note", TODAY_ISO, [], title),
    snippet,
  });

  it("drops the heading the excerpt starts with", () => {
    expect(rowSnippet(excerpt("レールの設計", "# レールの設計 ヘッダを畳んで柱にする"))).toBe(
      "ヘッダを畳んで柱にする",
    );
  });

  // For a one-line record the excerpt is the title itself. The same text is not repeated on
  // a second row
  it("is empty when the excerpt says nothing the title did not", () => {
    expect(rowSnippet(excerpt("朝ラン 5km #run", "朝ラン 5km #run"))).toBe("");
  });

  // If the title does not fit in 40 characters, the excerpt is the title cut off midway
  it("is empty when the excerpt is only part of the title", () => {
    expect(rowSnippet(excerpt("長い題がずっと続いている記録", "長い題がずっと…"))).toBe("");
  });

  it("keeps an excerpt that has nothing to do with the title", () => {
    expect(rowSnippet(excerpt("題", "まったく別の書き出し"))).toBe("まったく別の書き出し");
  });
});

describe("browseSeed", () => {
  it("opens on one kind and one tag", () => {
    expect(browseSeed({ kind: "scrawl", tag: "run" })).toStrictEqual({
      kinds: ["scrawl"],
      tags: ["run"],
      period: "all",
    });
  });

  it("drops the decorating hash the chip carries", () => {
    expect(browseSeed({ tag: "#run" })?.tags).toStrictEqual(["run"]);
  });

  // A filter nobody pressed is never applied silently. Opening Browse with `⌘F` selects
  // nothing
  it("is null when the road says nothing", () => {
    expect(browseSeed({})).toBeNull();
    expect(browseSeed({ kind: "tasks" })).toBeNull();
  });

  it("takes the first of a repeated parameter", () => {
    expect(browseSeed({ tag: ["run", "memo"] })?.tags).toStrictEqual(["run"]);
  });
});

describe("toggleKind / toggleTag", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleKind([], "note")).toStrictEqual(["note"]);
    expect(toggleKind(["note", "codex"], "note")).toStrictEqual(["codex"]);
  });

  // Removal also goes by identity. With an exact match, a tag whose chosen spelling differs
  // from the chip's would not come off when pressed
  it("removes a tag whatever the spelling", () => {
    expect(toggleTag(["Memo"], "memo")).toStrictEqual([]);
    expect(toggleTag([], "memo")).toStrictEqual(["memo"]);
  });
});
