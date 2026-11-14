/**
 * What Android's own back (the key, or the system's edge gesture) does here. Left to the
 * WebView it walks the browser history, which knows nothing of a sheet or a note
 * opened over its list: one back could leave a whole surface. Taken over, it peels the same
 * layers the palm's stroke to the right does, the topmost first.
 */

export interface BackLayers {
  /** A ring standing open for a tapped choice (`Ring.tsx`): the topmost of all. */
  ringOpen: boolean;
  jotOpen: boolean;
  searchOpen: boolean;
  paletteOpen: boolean;
  paper: boolean;
  /** The screen has a level under it (a note over its list, writing over reading). */
  level: boolean;
  /** The WebView has history to walk back through. */
  canGoBack: boolean;
}

export type BackStep =
  | "ring"
  | "jot"
  | "search"
  | "palette"
  | "paper"
  | "level"
  | "history"
  | "leave";

/** The layer one back peels: whatever floats first, then the screen's own level, then history. */
export function systemBackStep(layers: BackLayers): BackStep {
  if (layers.ringOpen) {
    return "ring";
  }
  if (layers.jotOpen) {
    return "jot";
  }
  if (layers.searchOpen) {
    return "search";
  }
  if (layers.paletteOpen) {
    return "palette";
  }
  if (layers.paper) {
    return "paper";
  }
  if (layers.level) {
    return "level";
  }
  return layers.canGoBack ? "history" : "leave";
}
