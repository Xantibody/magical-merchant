import { describe, it, expect } from "vitest";
import { countNoteTags, dayJumpHits, recentNoteHits } from "./palette-home";
import type { NoteItem } from "./items";

const TODAY = new Date(2026, 7, 16);

function item(overrides: Partial<NoteItem> = {}): NoteItem {
  return {
    kind: "note",
    id: "a.md",
    filename: "a.md",
    path: "/data/notes/a.md",
    date: "2026-08-14",
    time: "09:00",
    title: "タイトル",
    tags: [],
    preview: "タイトル\n本文",
    ...overrides,
  };
}

describe("recentNoteHits", () => {
  it("turns the head of the list into openable note hits", () => {
    const hits = recentNoteHits([
      item({ filename: "b.md", title: "二番目" }),
      item({ filename: "a.md", title: "一番目" }),
    ]);

    expect(hits[0]).toMatchObject({ kind: "note", filename: "b.md", title: "二番目" });
  });

  it("caps the list at five", () => {
    const items = Array.from({ length: 8 }, (_, i) => item({ filename: `${i}.md` }));
    expect(recentNoteHits(items)).toHaveLength(5);
  });

  it("is empty when there are no notes", () => {
    expect(recentNoteHits([])).toStrictEqual([]);
  });
});

describe("countNoteTags", () => {
  it("counts tags across notes, most used first", () => {
    const tags = countNoteTags([
      item({ tags: ["sync", "design"] }),
      item({ tags: ["sync"] }),
      item({ tags: [] }),
    ]);

    expect(tags).toStrictEqual([
      { tag: "sync", count: 2 },
      { tag: "design", count: 1 },
    ]);
  });

  // If the chip split in two, the same category would have to be pressed twice, separately
  it("counts notes that spell a tag differently as one chip", () => {
    const tags = countNoteTags([
      item({ filename: "a.md", tags: ["Memo"] }),
      item({ filename: "b.md", tags: ["memo"] }),
      item({ filename: "c.md", tags: ["MEMO"] }),
    ]);

    expect(tags).toStrictEqual([{ tag: "Memo", count: 3 }]);
  });

  // frontmatter is kept exactly as written, so one note can carry both spellings
  it("counts a note once even when it carries both spellings", () => {
    expect(countNoteTags([item({ tags: ["Memo", "memo"] })])).toStrictEqual([
      { tag: "Memo", count: 1 },
    ]);
  });

  it("is empty when no note has tags", () => {
    expect(countNoteTags([item()])).toStrictEqual([]);
  });
});

describe("dayJumpHits", () => {
  it("offers 今日 and 昨日 when both days have entries", () => {
    const hits = dayJumpHits(["2026-08-16", "2026-08-15", "2026-08-10"], TODAY);

    expect(hits.map((h) => h.label)).toStrictEqual(["今日", "昨日"]);
    expect(hits[0]?.hit).toMatchObject({ kind: "scrawl", date: "2026-08-16" });
  });

  // Offering a day with no records in the palette would land on a screen showing nothing
  it("omits a day that has no entries", () => {
    const hits = dayJumpHits(["2026-08-15"], TODAY);

    expect(hits.map((h) => h.label)).toStrictEqual(["昨日"]);
  });

  it("is empty when neither day has entries", () => {
    expect(dayJumpHits(["2026-08-01"], TODAY)).toStrictEqual([]);
  });
});
