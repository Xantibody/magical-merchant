/**
 * The coordinate maths for the diagram zoom screen. These are pure functions that do not
 * touch the DOM, so the same formula runs whether it comes from the wheel, a pinch or a
 * button, and the tests can be written with numbers alone.
 *
 * The transform is `translate(tx, ty) scale(s)`. tx/ty are screen pixels: where the top
 * left of the diagram lands. When the scale changes, the translation is corrected so that
 * the point under the cursor does not move. Otherwise the diagram runs away on every zoom.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 8;

/** How far past natural size to grow on open. Filling the screen with a small figure blurs it */
const FIT_MAX_SCALE = 2;

/** Margin (px) left around the diagram on open. The close button and controls do not cover it */
const FIT_PADDING = 96;

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Whether the side could be measured. A hidden surface or an SVG before it finishes drawing
 * returns 0, and an SVGRect with no attributes returns NaN. Neither may go into a division
 */
function measured(length: number): boolean {
  return Number.isFinite(length) && length > 0;
}

/**
 * The natural size on open. mermaid writes the natural size into the viewBox, so read that;
 * an SVG with no viewBox falls back to the shrunk size it is drawn at right now
 * (`getBoundingClientRect`). If neither can be measured, give no answer: opening at a size
 * of zero only puts a blank screen up
 */
export function zoomSize(viewBox: Size, rendered: Size): Size | undefined {
  const width = measured(viewBox.width) ? viewBox.width : rendered.width;
  const height = measured(viewBox.height) ? viewBox.height : rendered.height;
  return measured(width) && measured(height) ? { width, height } : undefined;
}

/** Where to put it when the scale cannot be measured: natural size, at the top left */
const NATURAL: Transform = { scale: 1, tx: 0, ty: 0 };

/**
 * Put it in the middle of the screen, at a size that fits with a margin left over. If
 * either side could not be measured, put it at natural size: a scale divided by 0 becomes
 * NaN or Infinity, the whole transform is ignored, the diagram vanishes, and the scale
 * readout says "NaN%"
 */
export function fitToViewport(viewport: Size, diagram: Size): Transform {
  if (
    !measured(viewport.width) ||
    !measured(viewport.height) ||
    !measured(diagram.width) ||
    !measured(diagram.height)
  ) {
    return NATURAL;
  }
  const scale = clamp(
    Math.min(
      (viewport.width - FIT_PADDING) / diagram.width,
      (viewport.height - FIT_PADDING) / diagram.height,
      FIT_MAX_SCALE,
    ),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    tx: (viewport.width - diagram.width * scale) / 2,
    ty: (viewport.height - diagram.height * scale) / 2,
  };
}

/** Multiply the scale by `factor` while the diagram point under `point` (screen) stays put */
export function zoomAtPoint(current: Transform, point: Point, factor: number): Transform {
  const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
  if (scale === current.scale) {
    return current;
  }
  const k = scale / current.scale;
  return {
    scale,
    tx: point.x - (point.x - current.tx) * k,
    ty: point.y - (point.y - current.ty) * k,
  };
}

/**
 * The factor for one wheel notch. It is exponential so that 100 steps up and 100 steps back
 * down land exactly where it started. The browser delivers a trackpad pinch as ctrl+wheel.
 * Its delta per event is small, so the coefficient is raised to keep up with the finger
 */
export function wheelFactor(deltaY: number, pinch: boolean): number {
  return Math.exp(-deltaY * (pinch ? 0.01 : 0.0022));
}

export function toCss(transform: Transform): string {
  return `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`;
}
