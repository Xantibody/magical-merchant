import { describe, it, expect } from "vitest";
import {
  daysSince,
  isBeforeRestore,
  spanSince,
  versionClock,
  versionDay,
  versionMessage,
  withDeltas,
} from "./versions";
import type { Version } from "./commands";

const version = (id: string, bytes: number, message: string | null = null): Version => ({
  id,
  time: "2026-09-17T14:03:00+09:00",
  message,
  bytes,
});

describe("withDeltas", () => {
  // The list is newest first. The difference is "how many bytes that version added", so
  // the neighbour is the row one below
  it("measures each version against the one before it", () => {
    const rows = withDeltas([version("c", 1500), version("b", 1200), version("a", 1300)]);

    expect(rows.map((row) => row.delta)).toStrictEqual([300, -100, 1300]);
  });

  it("is empty for a codex with no versions", () => {
    expect(withDeltas([])).toStrictEqual([]);
  });
});

describe("versionMessage", () => {
  // "before restore" is the fixed spelling core writes into the file. The screen shows it
  // in the current language
  it("translates the fixed message core writes before a restore", () => {
    expect(versionMessage(version("a", 1, "before restore"), "戻す前")).toBe("戻す前");
  });

  it("shows the author's own words untouched and nothing when there are none", () => {
    expect(versionMessage(version("a", 1, "第 3 章を足した"), "戻す前")).toBe("第 3 章を足した");
    expect(versionMessage(version("a", 1), "戻す前")).toBe("");
  });
});

describe("withDeltas numbering", () => {
  it("numbers versions from the oldest", () => {
    const rows = withDeltas([version("c", 1), version("b", 1), version("a", 1)]);

    expect(rows.map((row) => row.number)).toStrictEqual([3, 2, 1]);
  });
});

describe("version dates", () => {
  const v = version("a", 1);

  // time is the local time where it was written. It is not converted to the device's time zone
  it("reads the day and the clock off the recorded time", () => {
    expect(versionDay(v)).toBe("09/17");
    expect(versionClock(v)).toBe("14:03");
  });

  it("counts whole days up to now, never negative", () => {
    const now = new Date("2026-09-24T14:02:00+09:00");
    expect(daysSince(v.time, now)).toBe(6);
    expect(daysSince(v.time, new Date("2026-09-17T15:00:00+09:00"))).toBe(0);
    expect(daysSince(v.time, new Date("2026-09-10T15:00:00+09:00"))).toBe(0);
    expect(daysSince("garbage", now)).toBe(0);
  });

  // Months go by the calendar. It is one month only once the same day of the month is reached
  it("counts calendar months and falls back to days inside the first month", () => {
    expect(
      spanSince("2026-01-01T10:00:00+09:00", new Date("2026-09-17T00:00:00+09:00")),
    ).toStrictEqual({
      months: 8,
      days: 258,
    });
    expect(
      spanSince("2026-01-31T10:00:00+09:00", new Date("2026-02-28T00:00:00+09:00")).months,
    ).toBe(0);
    expect(
      spanSince("2026-09-10T10:00:00+09:00", new Date("2026-09-17T12:00:00+09:00")),
    ).toStrictEqual({
      months: 0,
      days: 7,
    });
  });

  it("knows the version core commits before a restore", () => {
    expect(isBeforeRestore(version("a", 1, "before restore"))).toBe(true);
    expect(isBeforeRestore(v)).toBe(false);
  });
});
