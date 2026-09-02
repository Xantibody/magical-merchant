import { describe, it, expect } from "vitest";
import {
  toTimelineItems,
  toNoteItems,
  groupTimelineByDay,
  groupNotes,
  itemTitle,
  noteCreatedLabel,
  notesByOrigin,
  orphanNotesByDate,
  originKeyOf,
  replaceDayItems,
  planBulkDelete,
  neighborOf,
} from "./items";
import type { Note } from "./commands";

const TODAY = new Date(2026, 7, 4);

function note(overrides: Partial<Note> = {}): Note {
  return {
    path: "/data/notes/a.md",
    filename: "a.md",
    time: "2026-08-04T15:27:00+09:00",
    tags: [],
    preview: "タイトル\n本文",
    ...overrides,
  };
}

describe("toTimelineItems", () => {
  it("addresses each entry by date and position", () => {
    const items = toTimelineItems("2026-08-04", ["- [09:00:00] one", "- [10:00:00] two"]);
    expect(items.map((i) => i.id)).toStrictEqual(["2026-08-04#1", "2026-08-04#0"]);
  });

  it("puts the newest entry of the day first", () => {
    const items = toTimelineItems("2026-08-04", ["- [09:00:00] one", "- [10:00:00] two"]);
    expect(items.map((i) => i.text)).toStrictEqual(["two", "one"]);
  });

  it("keeps the file position as the index so an edit reaches the right line", () => {
    const items = toTimelineItems("2026-08-04", ["- [09:00:00] one", "- [10:00:00] two"]);
    expect(items.map((i) => i.index)).toStrictEqual([1, 0]);
  });

  it("splits the recorded context out of the raw line", () => {
    const items = toTimelineItems("2026-08-04", ['- [09:00:00] hi {"battery":80}']);
    expect(items[0].text).toBe("hi");
    expect(items[0].context?.battery).toBe(80);
  });

  it("keeps the raw line so an edit can be written back", () => {
    const raw = "- [09:00:00] hi";
    expect(toTimelineItems("2026-08-04", [raw])[0].raw).toBe(raw);
  });
});

describe("toNoteItems", () => {
  it("takes the title from the first non-empty line", () => {
    expect(toNoteItems([note({ preview: "\n\n見出し\n本文" })])[0].title).toBe("見出し");
  });

  it("strips a Markdown heading marker from the title", () => {
    expect(toNoteItems([note({ preview: "## 見出し" })])[0].title).toBe("見出し");
  });

  it("labels a note with no body", () => {
    expect(toNoteItems([note({ preview: "   " })])[0].title).toBe("(空のメモ)");
  });

  it("空行として保存された <br /> 行はタイトルに拾わない", () => {
    // 本文の先頭で Enter を押したノートは <br /> 行から始まる。
    // それをタイトルにすると一覧に「<br />」と並ぶ
    expect(toNoteItems([note({ preview: "<br />\n見出し" })])[0].title).toBe("見出し");
  });

  it("空行 (<br />) しかないノートは空のメモ扱い", () => {
    expect(toNoteItems([note({ preview: "<br />\n<br>" })])[0].title).toBe("(空のメモ)");
  });

  it("splits the timestamp into a date and a time", () => {
    const [item] = toNoteItems([note()]);
    expect(item.date).toBe("2026-08-04");
    expect(item.time).toBe("15:27");
  });

  it("tolerates a note with no timestamp", () => {
    const [item] = toNoteItems([note({ time: undefined })]);
    expect(item.date).toBe("");
    expect(item.time).toBe("");
  });

  it("carries the origin of a promoted note", () => {
    const [item] = toNoteItems([note({ origin: "2026-08-03T08:30:00" })]);
    expect(item.origin).toBe("2026-08-03T08:30:00");
  });
});

describe("originKeyOf", () => {
  it("points at an entry with the same string promote writes into origin", () => {
    const [item] = toTimelineItems("2026-08-03", ["- [08:30:00] 朝の記録"]);
    expect(originKeyOf(item)).toBe("2026-08-03T08:30:00");
  });
});

describe("notesByOrigin", () => {
  it("returns an empty map when no note has an origin", () => {
    expect(notesByOrigin(toNoteItems([note()])).size).toBe(0);
  });

  it("groups promoted notes under the exact entry they grew from", () => {
    const items = toNoteItems([
      note({ filename: "a.md", origin: "2026-08-03T08:30:00" }),
      note({ filename: "b.md", origin: "2026-08-03T21:00:00" }),
      note({ filename: "c.md", origin: "2026-08-03T08:30:00" }),
    ]);
    const map = notesByOrigin(items);
    expect(map.get("2026-08-03T08:30:00")?.map((n) => n.filename)).toStrictEqual(["a.md", "c.md"]);
    expect(map.get("2026-08-03T21:00:00")?.map((n) => n.filename)).toStrictEqual(["b.md"]);
  });

  it("keys notes so an entry of the same day but another time does not match", () => {
    const [item] = toTimelineItems("2026-08-03", ["- [09:00:00] 別の記録"]);
    const map = notesByOrigin(toNoteItems([note({ origin: "2026-08-03T08:30:00" })]));
    expect(map.get(originKeyOf(item))).toBeUndefined();
  });
});

describe("orphanNotesByDate", () => {
  it("returns an empty map when no note has an origin", () => {
    expect(orphanNotesByDate(toNoteItems([note()]), []).size).toBe(0);
  });

  it("leaves out notes whose origin entry is still on the timeline", () => {
    const items = toTimelineItems("2026-08-03", ["- [08:30:00] 朝の記録"]);
    const notes = toNoteItems([note({ origin: "2026-08-03T08:30:00" })]);
    expect(orphanNotesByDate(notes, items).size).toBe(0);
  });

  it("groups notes whose origin entry is gone under the day of that origin", () => {
    const items = toTimelineItems("2026-08-03", ["- [08:30:00] 朝の記録"]);
    const notes = toNoteItems([
      note({ filename: "a.md", origin: "2026-08-03T21:00:00" }),
      note({ filename: "b.md", origin: "2026-08-01T07:00:00" }),
    ]);
    const map = orphanNotesByDate(notes, items);
    expect(map.get("2026-08-03")?.map((n) => n.filename)).toStrictEqual(["a.md"]);
    expect(map.get("2026-08-01")?.map((n) => n.filename)).toStrictEqual(["b.md"]);
  });
});

describe("groupTimelineByDay", () => {
  it("groups consecutive entries from the same day", () => {
    const items = [
      ...toTimelineItems("2026-08-04", ["- [09:00:00] a", "- [10:00:00] b"]),
      ...toTimelineItems("2026-08-03", ["- [11:00:00] c"]),
    ];
    const days = groupTimelineByDay(items);
    expect(days.map((d) => d.date)).toStrictEqual(["2026-08-04", "2026-08-03"]);
    expect(days[0].items).toHaveLength(2);
  });

  it("returns nothing for an empty timeline", () => {
    expect(groupTimelineByDay([])).toStrictEqual([]);
  });
});

describe("groupNotes", () => {
  it("splits this week from last week", () => {
    const items = toNoteItems([
      note({ filename: "a.md", time: "2026-08-04T10:00:00+09:00" }),
      note({ filename: "b.md", time: "2026-07-25T10:00:00+09:00" }),
    ]);
    expect(groupNotes(items, TODAY).map((g) => g.label)).toStrictEqual(["今週", "先週"]);
  });
});

describe("itemTitle", () => {
  it("uses the first line of a timeline entry", () => {
    const [item] = toTimelineItems("2026-08-04", ["- [09:00:00] one\ntwo"]);
    expect(itemTitle(item)).toBe("one");
  });

  it("labels an entry with no text", () => {
    const [item] = toTimelineItems("2026-08-04", ["- [09:00:00] "]);
    expect(itemTitle(item)).toBe("(空のメモ)");
  });
});

describe("noteCreatedLabel", () => {
  it("shows the creation time instead of the filename", () => {
    const [item] = toNoteItems([note({ time: "2026-05-03T15:39:45+09:00" })]);
    expect(noteCreatedLabel(item)).toBe("2026/05/03 15:39");
  });

  it("stays empty when the frontmatter had no readable time", () => {
    const [item] = toNoteItems([note({ time: undefined })]);
    expect(noteCreatedLabel(item)).toBe("");
  });
});

function day(date: string, texts: string[]): ReturnType<typeof toTimelineItems> {
  return toTimelineItems(
    date,
    texts.map((t, i) => `- [${String(i + 9).padStart(2, "0")}:00:00] ${t}`),
  );
}

describe("replaceDayItems", () => {
  it("swaps in the fresh entries for a day already on screen", () => {
    const items = [...day("2026-08-04", ["today"]), ...day("2026-08-03", ["yesterday"])];

    const updated = replaceDayItems(items, "2026-08-04", day("2026-08-04", ["today", "more"]));

    expect(updated.map((i) => i.text)).toStrictEqual(["more", "today", "yesterday"]);
  });

  it("puts the first entry of a new day at the top", () => {
    const items = day("2026-08-03", ["yesterday"]);

    const updated = replaceDayItems(items, "2026-08-04", day("2026-08-04", ["first"]));

    expect(updated.map((i) => i.date)).toStrictEqual(["2026-08-04", "2026-08-03"]);
  });

  it("slots an older day between its neighbours", () => {
    const items = [...day("2026-08-04", ["a"]), ...day("2026-08-01", ["c"])];

    const updated = replaceDayItems(items, "2026-08-02", day("2026-08-02", ["b"]));

    expect(updated.map((i) => i.date)).toStrictEqual(["2026-08-04", "2026-08-02", "2026-08-01"]);
  });

  it("drops the day entirely when no entries remain", () => {
    const items = [...day("2026-08-04", ["a"]), ...day("2026-08-03", ["b"])];

    const updated = replaceDayItems(items, "2026-08-04", []);

    expect(updated.map((i) => i.date)).toStrictEqual(["2026-08-03"]);
  });
});

const target = (date: string, index: number) => ({ date, index });

describe("planBulkDelete", () => {
  it("deletes within a day from the highest index so earlier deletes cannot shift later ones", () => {
    const plan = planBulkDelete([
      target("2026-08-04", 0),
      target("2026-08-04", 2),
      target("2026-08-04", 1),
    ]);
    expect(plan).toStrictEqual([
      target("2026-08-04", 2),
      target("2026-08-04", 1),
      target("2026-08-04", 0),
    ]);
  });

  it("keeps each day's deletes together while ordering indexes per day", () => {
    const plan = planBulkDelete([
      target("2026-08-04", 1),
      target("2026-08-03", 0),
      target("2026-08-04", 3),
      target("2026-08-03", 2),
    ]);
    expect(plan).toStrictEqual([
      target("2026-08-04", 3),
      target("2026-08-04", 1),
      target("2026-08-03", 2),
      target("2026-08-03", 0),
    ]);
  });

  it("returns nothing for an empty selection", () => {
    expect(planBulkDelete([])).toStrictEqual([]);
  });
});

const list = (...ids: string[]) => ids.map((id) => ({ id }));

describe("neighborOf", () => {
  it("has no neighbour when the deleted note was the only one", () => {
    expect(neighborOf(list("a"), "a")).toBeNull();
  });

  it("falls to the note below when the first note is deleted", () => {
    expect(neighborOf(list("a", "b", "c"), "a")).toBe("b");
  });

  it("moves to the note above when a middle note is deleted", () => {
    expect(neighborOf(list("a", "b", "c"), "b")).toBe("a");
  });

  it("moves to the note above when the last note is deleted", () => {
    expect(neighborOf(list("a", "b", "c"), "c")).toBe("b");
  });

  it("has no neighbour for an id that is not in the list", () => {
    expect(neighborOf(list("a", "b"), "zzz")).toBeNull();
  });
});
