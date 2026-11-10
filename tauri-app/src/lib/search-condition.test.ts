import { describe, it, expect } from "vitest";
import { hasCondition, periodRange, searchArgs } from "./search-condition";
import type { SearchCondition } from "./search-condition";

// A Monday would hide a week counted from the wrong day, so this is a Wednesday
const TODAY = new Date(2026, 10, 4);

const NO_CONDITION: SearchCondition = { text: "", tags: [], kind: "all", period: null };

describe("hasCondition", () => {
  it("does not count an empty field or stray spaces", () => {
    expect(hasCondition(NO_CONDITION)).toBe(false);
    expect(hasCondition({ ...NO_CONDITION, text: "   " })).toBe(false);
  });

  it.each([
    { text: "retry" },
    { tags: ["sync"] },
    { kind: "codex" as const },
    { period: "today" as const },
  ])("counts %o", (change) => {
    expect(hasCondition({ ...NO_CONDITION, ...change })).toBe(true);
  });
});

describe("periodRange", () => {
  it("makes today a single day", () => {
    expect(periodRange("today", TODAY)).toStrictEqual({ from: "2026-11-04", to: "2026-11-04" });
  });

  // Counted like the weekly digest, so the same words give the same number on both
  it("starts the week on Monday and ends it today", () => {
    expect(periodRange("week", TODAY)).toStrictEqual({ from: "2026-11-02", to: "2026-11-04" });
  });

  it("makes a year ago a single day", () => {
    expect(periodRange("yearAgo", TODAY)).toStrictEqual({ from: "2025-11-04", to: "2025-11-04" });
  });
});

describe("searchArgs", () => {
  it("asks nothing without a condition", () => {
    expect(searchArgs(NO_CONDITION, TODAY)).toBeNull();
  });

  it("does not hand core the word all", () => {
    expect(searchArgs({ ...NO_CONDITION, text: "retry" }, TODAY)).toStrictEqual({
      query: "retry",
      tags: [],
      filter: { kind: null, from: null, to: null },
    });
  });

  // Tags are AND here: adding a condition has to narrow
  it("takes the typed tags together with the chosen ones", () => {
    const args = searchArgs({ ...NO_CONDITION, text: "#sf6 ベガ", tags: ["fgc"] }, TODAY);

    expect(args?.query).toBe("ベガ");
    expect(args?.tags).toStrictEqual(["fgc", "sf6"]);
  });

  it("lists on a chip alone", () => {
    expect(searchArgs({ ...NO_CONDITION, kind: "note", period: "yearAgo" }, TODAY)).toStrictEqual({
      query: "",
      tags: [],
      filter: { kind: "note", from: "2025-11-04", to: "2025-11-04" },
    });
  });
});
