import { describe, it, expect } from "vitest";
import {
  MARK_PAD_PX,
  MARK_PX,
  NAME_ROOM_PX,
  PILL_PX,
  STEP_PX,
  pastRing,
  petalAt,
  ringLayout,
} from "./ring";
import type { Bounds, Point, RingAnchor, RingLayout } from "./ring";

const phone: Bounds = { width: 390, height: 844 };
const narrow: Bounds = { width: 360, height: 640 };
const wide: Bounds = { width: 1280, height: 800 };

/** The phone's round + low on the right, and the pill's Note button low on the left. */
const plus: RingAnchor = { x: 346, top: 772, bottom: 828 };
const pill: RingAnchor = { x: 92, top: 776, bottom: 824 };

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Each pill's box as drawn: its mark's end, and the most room a name can take. */
function pills(layout: RingLayout): Box[] {
  const half = MARK_PX / 2 + MARK_PAD_PX;
  const reach = layout.side === "left" ? -1 : 1;
  return layout.petals.map((p) => {
    const near = p.x - reach * half;
    const far = p.x + reach * (half + NAME_ROOM_PX);
    return {
      left: Math.min(near, far),
      right: Math.max(near, far),
      top: p.y - PILL_PX / 2,
      bottom: p.y + PILL_PX / 2,
    };
  });
}

function onScreen(layout: RingLayout, bounds: Bounds): boolean {
  return pills(layout).every(
    (box) =>
      box.left >= 0 && box.right <= bounds.width && box.top >= 0 && box.bottom <= bounds.height,
  );
}

/** Each neighbour pair, the nearer to the control first. */
function neighbours<T>(items: T[]): [T, T][] {
  return items.slice(1).map((item, i) => [items[i] as T, item]);
}

const petal = (layout: RingLayout, i: number): Point => layout.petals[i] as Point;

describe("ringLayout", () => {
  it("keeps every pill, names included, on the glass from either corner", () => {
    expect(onScreen(ringLayout(plus, 4, phone), phone)).toBe(true);
    expect(onScreen(ringLayout(pill, 4, phone), phone)).toBe(true);
    expect(onScreen(ringLayout({ x: 330, top: 580, bottom: 620 }, 4, narrow), narrow)).toBe(true);
    expect(onScreen(ringLayout({ x: 30, top: 600, bottom: 630 }, 4, narrow), narrow)).toBe(true);
  });

  it("runs the names into the screen, away from the nearer edge", () => {
    expect(ringLayout(plus, 4, phone).side).toBe("left");
    expect(ringLayout(pill, 4, phone).side).toBe("right");
  });

  it("rises from the foot and never lays a pill over the control it came from", () => {
    const layout = ringLayout(plus, 4, phone);
    expect(layout.up).toBe(true);
    expect(pills(layout).every((box) => box.bottom < plus.top)).toBe(true);
  });

  it("puts the first choice nearest the thumb, the rest one row further each", () => {
    const rises = neighbours(ringLayout(plus, 4, phone).petals).map(([a, b]) => a.y - b.y);
    expect(rises).toStrictEqual([STEP_PX, STEP_PX, STEP_PX]);
  });

  it("never lets two pills touch: a name belongs to one pill", () => {
    const gaps = neighbours(pills(ringLayout(pill, 4, phone))).map(([a, b]) => a.top - b.bottom);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
  });

  it("bends each pill a little further in, the way a thumb sweeps", () => {
    const fromRight = neighbours(ringLayout(plus, 4, phone).petals).map(([a, b]) => a.x - b.x);
    const fromLeft = neighbours(ringLayout(pill, 4, phone).petals).map(([a, b]) => b.x - a.x);
    expect(Math.min(...fromRight)).toBeGreaterThan(0);
    expect(Math.min(...fromLeft)).toBeGreaterThan(0);
  });

  it("hangs below the control when the glass above is too short", () => {
    const layout = ringLayout({ x: 600, top: 40, bottom: 80 }, 4, wide);
    expect(layout.up).toBe(false);
    expect(pills(layout).every((box) => box.top > 80)).toBe(true);
  });
});

describe("petalAt", () => {
  const layout = ringLayout(plus, 4, phone);

  it("finds the row under the thumb anywhere along its pill", () => {
    expect(petalAt(layout, petal(layout, 0))).toBe(0);
    // Over the name, far from the mark, and in the gap just above the pill
    const third = petal(layout, 2);
    expect(petalAt(layout, { x: third.x - 120, y: third.y - STEP_PX / 2 + 2 })).toBe(2);
  });

  it("finds nothing on the control itself or away to the side", () => {
    expect(petalAt(layout, { x: plus.x, y: (plus.top + plus.bottom) / 2 })).toBe(-1);
    expect(petalAt(layout, { x: 10, y: petal(layout, 0).y })).toBe(-1);
  });
});

describe("pastRing", () => {
  const layout = ringLayout(plus, 4, phone);

  it("is false on the pills and back on the control", () => {
    expect(pastRing(layout, petal(layout, 3))).toBe(false);
    expect(pastRing(layout, { x: plus.x, y: plus.top + 4 })).toBe(false);
  });

  it("is true past the far end, or well beside the pills", () => {
    expect(pastRing(layout, { x: plus.x, y: layout.top - STEP_PX })).toBe(true);
    expect(pastRing(layout, { x: layout.left - 60, y: petal(layout, 1).y })).toBe(true);
  });
});
