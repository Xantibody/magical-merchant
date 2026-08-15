import { describe, it, expect } from "vitest";
import { splitSnippet } from "./snippet-highlight";

describe("splitSnippet", () => {
  it("splits the snippet around the match", () => {
    expect(splitSnippet("short needle here", 6, 6)).toEqual({
      before: "short ",
      match: "needle",
      after: " here",
    });
  });

  // core の位置は文字数で来る。バイトや UTF-16 コード単位で切ると
  // 絵文字やサロゲートペアでずれる
  it("counts characters, not UTF-16 code units", () => {
    expect(splitSnippet("😀😀リトライ後", 2, 4)).toEqual({
      before: "😀😀",
      match: "リトライ",
      after: "後",
    });
  });

  it("returns null when there is no match position", () => {
    expect(splitSnippet("本文だけ", null, null)).toBeNull();
    expect(splitSnippet("本文だけ")).toBeNull();
  });

  // 古い core と新しい UI が混ざっても落ちない。範囲外は塗らないだけ
  it("returns null when the position runs past the snippet", () => {
    expect(splitSnippet("短い", 10, 4)).toBeNull();
  });
});
