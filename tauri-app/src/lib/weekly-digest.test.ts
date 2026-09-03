import { describe, it, expect } from "vitest";
import { digestWeekKey, isDigestDismissed, summarizeWeek, yearAgoToday } from "./weekly-digest";
import type { TimelineItem } from "./items";

/** 2026-08-16 は日曜。その週の月曜は 08-10。 */
const SUNDAY = new Date(2026, 7, 16);
const MONDAY = new Date(2026, 7, 10);

function entry(date: string, text: string): TimelineItem {
  return {
    kind: "timeline",
    id: `${date}#0`,
    date,
    index: 0,
    raw: text,
    text,
    time: "09:00:00",
    context: null,
  };
}

describe("digestWeekKey", () => {
  it("keys a week by its monday", () => {
    expect(digestWeekKey(SUNDAY)).toBe("2026-08-10");
  });

  it("a monday keys itself", () => {
    expect(digestWeekKey(MONDAY)).toBe("2026-08-10");
  });
});

describe("isDigestDismissed", () => {
  it("is not dismissed when nothing was stored", () => {
    expect(isDigestDismissed(null, SUNDAY)).toBe(false);
  });

  it("is dismissed for the rest of the same week", () => {
    expect(isDigestDismissed("2026-08-10", SUNDAY)).toBe(true);
  });

  // 先週閉じたカードが今週も出ないなら「週に一度」ではない
  it("reappears the next week", () => {
    expect(isDigestDismissed("2026-08-03", SUNDAY)).toBe(false);
  });
});

describe("summarizeWeek", () => {
  it("is empty with no entries", () => {
    expect(summarizeWeek([], SUNDAY)).toStrictEqual({ count: 0, days: 0, topTags: [] });
  });

  it("counts entries and distinct days within the week", () => {
    const summary = summarizeWeek(
      [
        entry("2026-08-15", "a #sync"),
        entry("2026-08-15", "b #sync"),
        entry("2026-08-11", "c #perf"),
      ],
      SUNDAY,
    );

    expect(summary.count).toBe(3);
    expect(summary.days).toBe(2);
    expect(summary.topTags.map((t) => t.tag)).toStrictEqual(["sync", "perf"]);
  });

  // 先週のエントリを混ぜると「今週のふりかえり」ではなくなる
  it("ignores entries before the week started", () => {
    const summary = summarizeWeek([entry("2026-08-09", "old")], SUNDAY);

    expect(summary.count).toBe(0);
  });

  it("caps the tags at three", () => {
    const summary = summarizeWeek([entry("2026-08-15", "#a #a #b #b #c #d")], SUNDAY);

    expect(summary.topTags).toHaveLength(3);
  });
});

describe("yearAgoToday", () => {
  it("returns the date when it has entries", () => {
    expect(yearAgoToday(SUNDAY, ["2025-08-16", "2025-08-15"])).toBe("2025-08-16");
  });

  it("returns null when that day has no entries", () => {
    expect(yearAgoToday(SUNDAY, ["2025-08-15"])).toBeNull();
  });
});
