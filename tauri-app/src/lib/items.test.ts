import { describe, it, expect } from "vitest";
import {
  toTimelineItems,
  toNoteItems,
  groupTimelineByDay,
  groupNotes,
  itemMeta,
  itemTitle,
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
    expect(items.map((i) => i.id)).toStrictEqual(["2026-08-04#0", "2026-08-04#1"]);
    expect(items[1].index).toBe(1);
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

describe("itemMeta", () => {
  it("shows time and device for a timeline entry", () => {
    const [item] = toTimelineItems("2026-08-04", ['- [15:27:45] hi {"os":"macos","arch":"x"}']);
    expect(itemMeta(item)).toBe("15:27 · macos");
  });

  it("omits the device when it was not recorded", () => {
    expect(itemMeta(toTimelineItems("2026-08-04", ["- [15:27:45] hi"])[0])).toBe("15:27");
  });

  it("shows date and tags for a note", () => {
    const [item] = toNoteItems([note({ tags: ["sync", "design"] })]);
    expect(itemMeta(item)).toBe("08/04 · #sync #design");
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
