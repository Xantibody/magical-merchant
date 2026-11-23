import { describe, it, expect } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  fitToViewport,
  toCss,
  wheelFactor,
  zoomAtPoint,
  zoomSize,
} from "./zoom-transform";
import type { Transform } from "./zoom-transform";

const VIEWPORT = { width: 1000, height: 800 };

/** A screen point mapped to diagram coordinates. Unchanged across a zoom means it is the anchor */
function diagramPoint(transform: Transform, x: number, y: number): [number, number] {
  return [(x - transform.tx) / transform.scale, (y - transform.ty) / transform.scale];
}

describe("zoomSize", () => {
  it("reads the natural size out of the viewBox", () => {
    expect(zoomSize({ width: 320, height: 120 }, { width: 700, height: 262 })).toStrictEqual({
      width: 320,
      height: 120,
    });
  });

  // An SVG with no viewBox does not state its natural size. The drawn size stands in
  it("falls back to the drawn size when there is no viewBox", () => {
    expect(zoomSize({ width: 0, height: 0 }, { width: 700, height: 262 })).toStrictEqual({
      width: 700,
      height: 262,
    });
  });

  /**
   * An SVG on a hidden surface, and an SVG that has not finished drawing, both measure
   * as 0. Opening with a 0 gives a screen showing nothing, and the scale math divides by
   * zero and comes out NaN
   */
  it("has no answer when neither the viewBox nor the rect can be measured", () => {
    expect(zoomSize({ width: 0, height: 0 }, { width: 0, height: 0 })).toBeUndefined();
  });

  it("has no answer for a size that is not a finite number", () => {
    expect(zoomSize({ width: Number.NaN, height: 120 }, { width: 0, height: 0 })).toBeUndefined();
  });
});

describe("fitToViewport", () => {
  it("shrinks a wide diagram until it sits inside the padded viewport", () => {
    const transform = fitToViewport(VIEWPORT, { width: 2000, height: 400 });

    // (1000 - 96) / 2000
    expect(transform.scale).toBeCloseTo(0.452);
    expect(transform.tx).toBeCloseTo((1000 - 2000 * 0.452) / 2);
    expect(transform.ty).toBeCloseTo((800 - 400 * 0.452) / 2);
  });

  it("does not blow a small diagram up past twice its size", () => {
    const transform = fitToViewport(VIEWPORT, { width: 100, height: 100 });

    expect(transform.scale).toBe(2);
    expect(transform.tx).toBe(400);
    expect(transform.ty).toBe(300);
  });

  it("never goes below the minimum on a viewport smaller than the padding", () => {
    const transform = fitToViewport({ width: 50, height: 50 }, { width: 100, height: 100 });

    expect(transform.scale).toBe(MIN_SCALE);
  });

  /**
   * Dividing by 0 makes the scale NaN or Infinity, the transform is then ignored whole,
   * the diagram disappears, and the readout at the bottom right says "NaN%". When it
   * cannot be measured, leave it at natural size
   */
  it("stays at natural size when the diagram has no size", () => {
    expect(fitToViewport(VIEWPORT, { width: 0, height: 0 })).toStrictEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
  });

  it("stays at natural size when the viewport has not been measured", () => {
    expect(fitToViewport({ width: 0, height: 0 }, { width: 200, height: 100 })).toStrictEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
  });

  it("stays at natural size when a measurement is not a finite number", () => {
    expect(fitToViewport(VIEWPORT, { width: Number.NaN, height: 100 })).toStrictEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
  });
});

describe("zoomAtPoint", () => {
  const start: Transform = { scale: 1, tx: 100, ty: 50 };

  it("keeps the point under the cursor where it is", () => {
    const before = diagramPoint(start, 300, 200);

    const zoomed = zoomAtPoint(start, { x: 300, y: 200 }, 1.6);

    expect(zoomed.scale).toBeCloseTo(1.6);
    const after = diagramPoint(zoomed, 300, 200);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it("stops at the maximum scale", () => {
    const zoomed = zoomAtPoint(start, { x: 0, y: 0 }, 1000);

    expect(zoomed.scale).toBe(MAX_SCALE);
  });

  it("stops at the minimum scale", () => {
    const zoomed = zoomAtPoint(start, { x: 0, y: 0 }, 0.0001);

    expect(zoomed.scale).toBe(MIN_SCALE);
  });

  it("leaves the transform alone when clamping changes nothing", () => {
    const atMax: Transform = { scale: MAX_SCALE, tx: -10, ty: -20 };

    expect(zoomAtPoint(atMax, { x: 5, y: 5 }, 2)).toStrictEqual(atMax);
  });
});

describe("wheelFactor", () => {
  it("zooms in when the wheel rolls away from the user", () => {
    expect(wheelFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, false)).toBeLessThan(1);
  });

  it("moves faster for a trackpad pinch (ctrl + wheel)", () => {
    expect(wheelFactor(-100, true)).toBeGreaterThan(wheelFactor(-100, false));
  });
});

describe("toCss", () => {
  it("translates before it scales, so tx/ty stay in screen pixels", () => {
    expect(toCss({ scale: 1.5, tx: 10, ty: -20 })).toBe("translate(10px, -20px) scale(1.5)");
  });
});
