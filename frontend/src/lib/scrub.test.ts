import { describe, it, expect } from "vitest";
import { scrubIndex, scrubYears } from "./scrub";

describe("scrubIndex", () => {
  it("runs from the newest day at the top to the oldest at the bottom", () => {
    expect(scrubIndex(0, 10)).toBe(0);
    expect(scrubIndex(1, 10)).toBe(9);
    expect(scrubIndex(0.5, 11)).toBe(5);
  });

  it("stays on the track past either end", () => {
    expect(scrubIndex(-0.2, 10)).toBe(0);
    expect(scrubIndex(1.4, 10)).toBe(9);
  });

  it("has nowhere to go with one day or none", () => {
    expect(scrubIndex(0.7, 1)).toBe(0);
    expect(scrubIndex(0.7, 0)).toBe(0);
  });
});

describe("scrubYears", () => {
  it("marks where each older year begins", () => {
    const dates = ["2026-11-12", "2026-01-03", "2025-12-30", "2025-02-01", "2024-08-13"];

    expect(scrubYears(dates)).toStrictEqual([
      { year: "2025", fraction: 0.5 },
      { year: "2024", fraction: 1 },
    ]);
  });

  // The top of the track is the current year already, and the thumb rests there
  it("leaves the newest year unmarked", () => {
    expect(scrubYears(["2026-11-12", "2026-11-01"])).toStrictEqual([]);
  });
});
