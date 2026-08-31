import { describe, it, expect } from "vitest";
import { keyboardTop, keyboardTopStyle } from "./keyboard";

describe("keyboardTop", () => {
  const WINDOW_HEIGHT = 900;

  // Android では閉じていても visualViewport がナビゲーションバーぶんを含んだ
  // 全高を返すので、その値で固定すると道具立てがバーの裏に潜り込む
  it("returns nothing while the keyboard is closed", () => {
    expect(keyboardTop({ offsetTop: 0, height: WINDOW_HEIGHT }, WINDOW_HEIGHT)).toBeUndefined();
  });

  it("ignores a shrink too small to be a keyboard", () => {
    expect(keyboardTop({ offsetTop: 0, height: 860 }, WINDOW_HEIGHT)).toBeUndefined();
  });

  it("returns the keyboard top once it opens", () => {
    expect(keyboardTop({ offsetTop: 0, height: 500 }, WINDOW_HEIGHT)).toBe(500);
  });

  it("follows the viewport while it is scrolled", () => {
    expect(keyboardTop({ offsetTop: 120, height: 500 }, WINDOW_HEIGHT)).toBe(620);
  });
});

describe("keyboardTopStyle", () => {
  // 閉じているあいだは貼り付く場所を CSS の bottom に預ける
  it("returns no style while the keyboard is closed", () => {
    expect(keyboardTopStyle()).toBeUndefined();
  });

  it("pins to the keyboard top once it opens", () => {
    expect(keyboardTopStyle(500)).toStrictEqual({
      top: "500px",
      bottom: "auto",
      transform: "translateY(-100%)",
    });
  });
});
