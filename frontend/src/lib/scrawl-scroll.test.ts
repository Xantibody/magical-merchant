import { describe, it, expect } from "vitest";
import { awayFromNewest } from "./scrawl-scroll";

describe("awayFromNewest", () => {
  it("stays quiet at the top and within a short flick of it", () => {
    expect(awayFromNewest(0, 700)).toBe(false);
    expect(awayFromNewest(525, 700)).toBe(false);
  });

  it("offers the way back once the newest are out of sight", () => {
    expect(awayFromNewest(526, 700)).toBe(true);
    expect(awayFromNewest(4000, 700)).toBe(true);
  });

  // A shorter window (the keyboard up) needs less scrolling to lose them
  it("measures by the visible height", () => {
    expect(awayFromNewest(400, 500)).toBe(true);
    expect(awayFromNewest(400, 800)).toBe(false);
  });
});
