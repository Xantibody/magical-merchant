import { describe, it, expect } from "vitest";
import { isImeComposing } from "./ime";

describe("isImeComposing", () => {
  it("returns false for a plain Enter", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });

  it("returns true while the IME is composing", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(
      true,
    );
  });

  // isComposing が立たない古い WebKit は keyCode 229 だけで合成中を伝える
  it("returns true for the legacy keyCode 229", () => {
    const e = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(e, "keyCode", { value: 229 });
    expect(isImeComposing(e)).toBe(true);
  });
});
