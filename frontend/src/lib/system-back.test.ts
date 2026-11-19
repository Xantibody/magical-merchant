import { describe, it, expect } from "vitest";
import { systemBackStep } from "./system-back";
import type { BackLayers } from "./system-back";

const bare: BackLayers = {
  ringOpen: false,
  jotOpen: false,
  searchOpen: false,
  paletteOpen: false,
  paper: false,
  level: false,
  canGoBack: false,
};

describe("systemBackStep", () => {
  // A ring left standing for a tap is the topmost thing, even over the line it bloomed beside
  it("folds a standing ring first", () => {
    expect(systemBackStep({ ...bare, ringOpen: true, jotOpen: true, level: true })).toBe("ring");
  });

  it("puts away what floats before anything else", () => {
    expect(systemBackStep({ ...bare, jotOpen: true, level: true })).toBe("jot");
    expect(systemBackStep({ ...bare, searchOpen: true, level: true })).toBe("search");
  });

  it("brings the chrome back before leaving the page alone's note", () => {
    expect(systemBackStep({ ...bare, paper: true, level: true })).toBe("paper");
  });

  // The same as a stroke to the right: a note goes back to its list, not off the surface
  it("goes one level out on a screen that has one", () => {
    expect(systemBackStep({ ...bare, level: true, canGoBack: true })).toBe("level");
  });

  it("walks the history only once nothing on the screen is left to peel", () => {
    expect(systemBackStep({ ...bare, canGoBack: true })).toBe("history");
    expect(systemBackStep(bare)).toBe("leave");
  });
});
