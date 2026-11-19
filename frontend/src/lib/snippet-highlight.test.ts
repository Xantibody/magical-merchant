import { describe, it, expect } from "vitest";
import { splitSnippet } from "./snippet-highlight";

describe("splitSnippet", () => {
  it("splits the snippet around the match", () => {
    expect(splitSnippet("short needle here", 6, 6)).toStrictEqual({
      before: "short ",
      match: "needle",
      after: " here",
    });
  });

  // core's positions come in characters. Cutting by bytes or UTF-16 code units
  // drifts on emoji and surrogate pairs
  it("counts characters, not UTF-16 code units", () => {
    expect(splitSnippet("😀😀リトライ後", 2, 4)).toStrictEqual({
      before: "😀😀",
      match: "リトライ",
      after: "後",
    });
  });

  it("returns null when there is no match position", () => {
    expect(splitSnippet("本文だけ", null, null)).toBeNull();
    expect(splitSnippet("本文だけ")).toBeNull();
  });

  // An old core mixed with a new UI does not crash. Out of range is simply not painted
  it("returns null when the position runs past the snippet", () => {
    expect(splitSnippet("短い", 10, 4)).toBeNull();
  });
});
