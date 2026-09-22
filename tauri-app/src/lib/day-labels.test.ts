import { describe, it, expect } from "vitest";
import {
  parseIsoDate,
  toIsoDate,
  daysBetween,
  formatDayHeading,
  formatNoteGroupLabel,
} from "./day-labels";
import { setLocale } from "./i18n";

const TODAY = new Date(2026, 7, 4); // 2026-08-04

// A heading changes both its words and their order per language. Watching only Japanese,
// a mixed line in English, a Japanese-style date followed by "Monday", would go unnoticed
describe("in english", () => {
  it("names the day in english", () => {
    setLocale("en");
    expect(formatDayHeading("2026-08-04", TODAY)).toStrictEqual({
      label: "Today",
      date: "Aug 4 Tuesday",
    });
  });

  it("names the note group in english", () => {
    setLocale("en");
    expect(formatNoteGroupLabel("2026-07-20", TODAY)).toBe("Earlier");
  });
});

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

describe("formatDayHeading", () => {
  it("names today and dates it", () => {
    expect(formatDayHeading("2026-08-04", TODAY)).toStrictEqual({
      label: "今日",
      date: "8月4日 火曜日",
    });
  });

  it("names yesterday", () => {
    expect(formatDayHeading("2026-08-03", TODAY)).toStrictEqual({
      label: "昨日",
      date: "8月3日 月曜日",
    });
  });

  // A distance at which the date itself is more of a clue than "3 days ago".
  it("uses the date itself as the label further back", () => {
    expect(formatDayHeading("2026-07-29", TODAY)).toStrictEqual({
      label: "7月29日",
      date: "水曜日",
    });
  });

  it("passes unparsable input through untouched", () => {
    expect(formatDayHeading("garbage", TODAY)).toStrictEqual({ label: "garbage", date: "" });
  });
});

describe("formatNoteGroupLabel", () => {
  // The notes being written now should sit together at the head of the list. Mixed into
  // "this week", the one made a moment ago has to be found among seven days of them
  it("keeps today's notes in their own group", () => {
    expect(formatNoteGroupLabel("2026-08-04", TODAY)).toBe("今日");
  });

  it("groups the six days before that as this week", () => {
    expect(formatNoteGroupLabel("2026-08-03", TODAY)).toBe("今週");
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
