import { describe, it, expect } from "vitest";
import {
  parseIsoDate,
  toIsoDate,
  daysBetween,
  formatDayLabel,
  formatNoteGroupLabel,
  formatDateTime,
} from "./day-labels";

const TODAY = new Date(2026, 7, 4); // 2026-08-04

describe("parseIsoDate", () => {
  it("reads the date in local time, not UTC", () => {
    const date = parseIsoDate("2026-08-04");
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(7);
    expect(date?.getDate()).toBe(4);
  });

  it("returns null for anything that is not YYYY-MM-DD", () => {
    expect(parseIsoDate("2026/08/04")).toBeNull();
    expect(parseIsoDate("not-a-date")).toBeNull();
  });
});

describe("toIsoDate", () => {
  it("zero-pads month and day", () => {
    expect(toIsoDate(new Date(2026, 0, 9))).toBe("2026-01-09");
  });

  it("round-trips with parseIsoDate", () => {
    expect(toIsoDate(parseIsoDate("2026-12-31") as Date)).toBe("2026-12-31");
  });
});

describe("daysBetween", () => {
  it("counts calendar days and ignores the time of day", () => {
    const from = new Date(2026, 7, 3, 23, 59);
    const to = new Date(2026, 7, 4, 0, 1);
    expect(daysBetween(from, to)).toBe(1);
  });

  it("is negative when the first date is later", () => {
    expect(daysBetween(new Date(2026, 7, 5), TODAY)).toBe(-1);
  });
});

describe("formatDayLabel", () => {
  it("names today", () => {
    expect(formatDayLabel("2026-08-04", TODAY)).toBe("今日 — 8/4");
  });

  it("names yesterday", () => {
    expect(formatDayLabel("2026-08-03", TODAY)).toBe("昨日 — 8/3");
  });

  it("falls back to a plain date further back", () => {
    expect(formatDayLabel("2026-07-29", TODAY)).toBe("7月29日");
  });

  it("passes unparsable input through untouched", () => {
    expect(formatDayLabel("garbage", TODAY)).toBe("garbage");
  });
});

describe("formatNoteGroupLabel", () => {
  it("groups the last seven days as this week", () => {
    expect(formatNoteGroupLabel("2026-08-04", TODAY)).toBe("今週");
    expect(formatNoteGroupLabel("2026-07-29", TODAY)).toBe("今週");
  });

  it("groups the seven days before that as last week", () => {
    expect(formatNoteGroupLabel("2026-07-28", TODAY)).toBe("先週");
    expect(formatNoteGroupLabel("2026-07-22", TODAY)).toBe("先週");
  });

  it("groups anything older together", () => {
    expect(formatNoteGroupLabel("2026-07-21", TODAY)).toBe("それ以前");
  });

  it("treats a future date as this week", () => {
    expect(formatNoteGroupLabel("2026-08-10", TODAY)).toBe("今週");
  });

  it("labels a note with no date", () => {
    expect(formatNoteGroupLabel("", TODAY)).toBe("日付なし");
  });
});

describe("formatDateTime", () => {
  it("drops the seconds", () => {
    expect(formatDateTime("2026-08-04", "15:27:45")).toBe("2026-08-04 15:27");
  });

  it("shows the date alone when there is no time", () => {
    expect(formatDateTime("2026-08-04", "")).toBe("2026-08-04");
  });
});
