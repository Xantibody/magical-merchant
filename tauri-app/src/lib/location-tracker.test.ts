import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLocationTracker, LOCATION_BUDGET_MS } from "./location-tracker";
import type { Coordinates } from "./location-tracker";

const SHIBUYA: Coordinates = { latitude: 35.658, longitude: 139.7 };
const NONE: Coordinates = { latitude: null, longitude: null };

/** 解決タイミングを手で握る測位。GPS のフィックス遅延を再現する。 */
function manualPosition(): { position: () => Promise<Coordinates>; resolve: (c: Coordinates) => void; calls: () => number } {
  let resolvers: ((c: Coordinates) => void)[] = [];
  let calls = 0;
  return {
    position: () => {
      calls += 1;
      // 解決を外から握るには executor を書くしかない
      // oxlint-disable-next-line promise/avoid-new
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
    resolve: (c: Coordinates) => {
      for (const res of resolvers) {
        res(c);
      }
      resolvers = [];
    },
    calls: () => calls,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createLocationTracker", () => {
  it("uses the fix when it arrives within the budget", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({ permitted: () => Promise.resolve(true), position: gps.position });

    const reading = tracker.read();
    await vi.advanceTimersByTimeAsync(0);
    gps.resolve(SHIBUYA);

    await expect(reading).resolves.toEqual(SHIBUYA);
  });

  // 保存が測位を待ち続けると「即座に保存される」が壊れる。位置は諦めてよい。
  it("saves without a location once the budget runs out", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({ permitted: () => Promise.resolve(true), position: gps.position });

    const reading = tracker.read();
    await vi.advanceTimersByTimeAsync(LOCATION_BUDGET_MS);

    await expect(reading).resolves.toEqual(NONE);
  });

  it("uses a fix that arrived late for the next capture", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({ permitted: () => Promise.resolve(true), position: gps.position });

    const first = tracker.read();
    await vi.advanceTimersByTimeAsync(LOCATION_BUDGET_MS);
    await first;
    gps.resolve(SHIBUYA);
    await vi.advanceTimersByTimeAsync(0);

    // 2 回目は新しいフィックスを待たされず、手元にある前回の座標で即返る
    await expect(tracker.read()).resolves.toEqual(SHIBUYA);
  });

  it("never asks the GPS when permission is denied", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({ permitted: () => Promise.resolve(false), position: gps.position });

    await expect(tracker.read()).resolves.toEqual(NONE);
    expect(gps.calls()).toBe(0);
  });

  it("warms up without showing a permission dialog", async () => {
    const gps = manualPosition();
    const requests: boolean[] = [];
    const tracker = createLocationTracker({
      permitted: (request) => {
        requests.push(request);
        return Promise.resolve(true);
      },
      position: gps.position,
    });

    tracker.warmUp();
    await vi.advanceTimersByTimeAsync(0);

    expect(requests).toEqual([false]);
  });

  it("lets the first capture use the coordinates the warm-up fetched", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({ permitted: () => Promise.resolve(true), position: gps.position });

    tracker.warmUp();
    await vi.advanceTimersByTimeAsync(0);
    gps.resolve(SHIBUYA);
    await vi.advanceTimersByTimeAsync(0);

    await expect(tracker.read()).resolves.toEqual(SHIBUYA);
  });

  it("shares one in-flight fix between overlapping reads", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({ permitted: () => Promise.resolve(true), position: gps.position });

    const first = tracker.read();
    const second = tracker.read();
    await vi.advanceTimersByTimeAsync(0);
    gps.resolve(SHIBUYA);

    await expect(first).resolves.toEqual(SHIBUYA);
    await expect(second).resolves.toEqual(SHIBUYA);
    expect(gps.calls()).toBe(1);
  });

  it("falls back to no location when the permission check itself blows up", async () => {
    const gps = manualPosition();
    const tracker = createLocationTracker({
      permitted: () => Promise.reject(new Error("plugin missing on this platform")),
      position: gps.position,
    });

    await expect(tracker.read()).resolves.toEqual(NONE);
  });
});
