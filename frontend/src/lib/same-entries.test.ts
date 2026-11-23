import { describe, it, expect } from "vitest";
import { sameEntries } from "./same-entries";

describe("sameEntries", () => {
  it("treats two empty tables as the same", () => {
    expect(sameEntries(new Map(), new Map())).toBe(true);
  });

  it("treats two tables with the same entries as the same", () => {
    expect(sameEntries(new Map([["a", "1"]]), new Map([["a", "1"]]))).toBe(true);
  });

  // A lookup table does not care in which order the rows arrived
  it("ignores the order the entries were added in", () => {
    const first = new Map([
      ["a", "1"],
      ["b", "2"],
    ]);
    const second = new Map([
      ["b", "2"],
      ["a", "1"],
    ]);

    expect(sameEntries(first, second)).toBe(true);
  });

  it("tells tables apart by a changed value", () => {
    expect(sameEntries(new Map([["a", "1"]]), new Map([["a", "2"]]))).toBe(false);
  });

  it("tells tables apart by a changed key", () => {
    expect(sameEntries(new Map([["a", "1"]]), new Map([["b", "1"]]))).toBe(false);
  });

  it("tells tables apart by an added entry", () => {
    const one = new Map([["a", "1"]]);
    const two = new Map([
      ["a", "1"],
      ["b", "2"],
    ]);

    expect(sameEntries(one, two)).toBe(false);
    expect(sameEntries(two, one)).toBe(false);
  });

  // `get` answers undefined both for a missing key and for one holding undefined
  it("tells a missing key from one that holds undefined", () => {
    const held = new Map<string, string | undefined>([["a", undefined]]);
    const missing = new Map<string, string | undefined>([["b", undefined]]);

    expect(sameEntries(held, missing)).toBe(false);
  });
});
