import { describe, it, expect } from "vitest";
import { keyboardTop, keyboardTopStyle } from "./keyboard";

describe("keyboardTop", () => {
  const WINDOW_HEIGHT = 900;

  // On Android `visualViewport` returns the full height including the navigation bar even
  // while closed, so pinning to that value slips the tools under the bar
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
  // While it is closed, leave where it sticks to the CSS `bottom`
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
