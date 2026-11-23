import { describe, it, expect } from "vitest";
import { scrawlDays } from "./scrawl-days";
import { toScrawlItems } from "./items";
import type { NoteItem } from "./items";

function note(overrides: Partial<NoteItem> = {}): NoteItem {
  return {
    kind: "note",
    id: "20261019_091200.md",
    filename: "20261019_091200.md",
    path: "/data/notes/20261019_091200.md",
    date: "2026-10-19",
    time: "09:12",
    title: "Weekly review",
    tags: [],
    preview: "Weekly review",
    ...overrides,
  };
}

const TODAY = "2026-10-19";

describe("scrawlDays", () => {
  it("has no days when nothing is recorded", () => {
    expect(scrawlDays([], [], TODAY)).toStrictEqual([]);
  });

  it("puts the newest day first and a day's newest record first", () => {
    const entries = [
      ...toScrawlItems("2026-10-19", ["- [08:10:00] water", "- [10:30:00] rail"]),
      ...toScrawlItems("2026-10-18", ["- [07:40:00] walk"]),
    ];

    const days = scrawlDays(entries, [], TODAY);

    expect(days.map((d) => d.date)).toStrictEqual(["2026-10-19", "2026-10-18"]);
    expect(days[0].rows.map((r) => r.time)).toStrictEqual(["10:30", "08:10"]);
  });

  it("lays a Note between the entries of its day by time", () => {
    const entries = toScrawlItems("2026-10-19", ["- [08:10:00] water", "- [10:30:00] rail"]);

    const days = scrawlDays(entries, [note()], TODAY);

    expect(days[0].rows.map((r) => r.kind)).toStrictEqual(["scrawl", "note", "scrawl"]);
  });

  it("shows a day that holds only a Note", () => {
    const entries = toScrawlItems("2026-10-18", ["- [07:40:00] walk"]);

    const days = scrawlDays(entries, [note()], TODAY);

    expect(days.map((d) => d.date)).toStrictEqual(["2026-10-19", "2026-10-18"]);
  });

  // The chip under the entry already leads to it; a row as well would say it twice
  it("leaves out a note whose origin entry is on screen", () => {
    const entries = toScrawlItems("2026-10-19", ["- [08:10:00] water"]);

    const days = scrawlDays(entries, [note({ origin: "2026-10-19T08:10:00" })], TODAY);

    expect(days[0].rows.map((r) => r.kind)).toStrictEqual(["scrawl"]);
  });

  // With its origin gone there is no chip to reach it by
  it("gives a row to a note whose origin entry is gone", () => {
    const entries = toScrawlItems("2026-10-19", ["- [08:10:00] water"]);

    const days = scrawlDays(entries, [note({ origin: "2026-10-01T08:10:00" })], TODAY);

    expect(days[0].rows.map((r) => r.kind)).toStrictEqual(["note", "scrawl"]);
  });

  // The list matches rows by reference, so a fresh wrapper would rebuild a record that did not change
  it("hands back the same row for a record that did not change", () => {
    const yesterday = toScrawlItems("2026-10-18", ["- [07:40:00] walk"]);
    const weekly = note();
    const before = scrawlDays(yesterday, [weekly], TODAY);

    const after = scrawlDays(
      [...toScrawlItems("2026-10-19", ["- [10:30:00] rail"]), ...yesterday],
      [weekly],
      TODAY,
    );

    expect(after[1].rows[0]).toBe(before[1].rows[0]);
    expect(after[0].rows.find((row) => row.kind === "note")).toBe(before[0].rows[0]);
  });

  // Notes are all loaded at once; days older than the loaded entries would appear as islands
  it("does not reach past the oldest loaded day", () => {
    const entries = toScrawlItems("2026-10-18", ["- [07:40:00] walk"]);

    const days = scrawlDays(entries, [note({ date: "2025-01-01" })], TODAY);

    expect(days.map((d) => d.date)).toStrictEqual(["2026-10-18"]);
  });
});
