import { describe, it, expect } from "vitest";
import { slimStep, WHOLE } from "./slim";
import type { SlimState } from "./slim";

/** Feeds a run of scroll positions through, as the scroll events would. */
const run = (tops: number[], from: SlimState = WHOLE): SlimState =>
  tops.reduce((state, top) => slimStep(state, top), from);

describe("slimStep", () => {
  it("stays whole near the top", () => {
    expect(run([10, 30, 50]).slim).toBe(false);
  });

  it("slims once reading has gone on down a little", () => {
    expect(run([40, 60, 80]).slim).toBe(false);
    expect(run([40, 60, 80, 90]).slim).toBe(true);
  });

  it("comes back as soon as the page turns up", () => {
    const reading = run([100, 200, 400]);
    expect(reading.slim).toBe(true);
    expect(run([390], reading).slim).toBe(true);
    expect(run([390, 380], reading).slim).toBe(false);
  });

  it("does not flicker on a pixel of settle after a fling", () => {
    const reading = run([100, 200, 400]);
    expect(run([399, 400, 398], reading).slim).toBe(true);
  });

  it("is whole again at the top, whichever way it got there", () => {
    const reading = run([100, 200, 400]);
    expect(run([20], reading).slim).toBe(false);
  });
});
