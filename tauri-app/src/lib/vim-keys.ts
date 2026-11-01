/**
 * What a key means to the Vim layer of the editor. Pure: it knows neither the DOM nor
 * ProseMirror, only the mode, the key waiting for its second half (`g`, `d`, `y`) and the
 * key just pressed. `vim-plugin.ts` turns the action into a change of the document.
 *
 * The set is deliberately small (plan 36): motions and line-wise edits, no counts, no
 * operator + motion, no text objects. The real Vim is one `$EDITOR` away through the CLI.
 */

import { isImeComposing } from "./ime";

export type VimMode = "insert" | "normal" | "visual" | "visual-line";

export type VimMotion =
  | "left"
  | "right"
  | "down"
  | "up"
  | "word-forward"
  | "word-backward"
  | "line-start"
  | "line-end"
  | "doc-start"
  | "doc-end";

export type InsertAt = "before" | "after" | "line-start" | "line-end" | "open-below" | "open-above";

export type VimAction =
  /** Not ours: the editor and the app handle it as if there were no Vim layer. */
  | { type: "pass" }
  /** Taken and dropped, so that nothing typed in normal mode becomes text. */
  | { type: "swallow" }
  | { type: "normal" }
  | { type: "insert"; at: InsertAt }
  | { type: "visual"; linewise: boolean }
  | { type: "move"; motion: VimMotion }
  | { type: "delete-char" }
  | { type: "delete-line" }
  | { type: "yank-line" }
  | { type: "put"; before: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "operate"; op: "delete" | "yank" | "change" };

export interface VimKey {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
}

export interface Interpreted {
  action: VimAction;
  /** The first half of a two-key command, or "" when nothing is waiting. */
  pending: string;
}

const MOTIONS: Readonly<Record<string, VimMotion>> = {
  h: "left",
  l: "right",
  j: "down",
  k: "up",
  w: "word-forward",
  b: "word-backward",
  0: "line-start",
  $: "line-end",
  G: "doc-end",
  // Outside insert the body is not editable, so the arrows no longer reach ProseMirror.
  // Vim reads them as the letters anyway
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "down",
  ArrowUp: "up",
};

const INSERTS: Readonly<Record<string, InsertAt>> = {
  i: "before",
  a: "after",
  I: "line-start",
  A: "line-end",
  o: "open-below",
  O: "open-above",
};

const NORMAL: Readonly<Record<string, VimAction>> = {
  x: { type: "delete-char" },
  p: { type: "put", before: false },
  P: { type: "put", before: true },
  u: { type: "undo" },
  v: { type: "visual", linewise: false },
  V: { type: "visual", linewise: true },
};

const OPERATORS: Readonly<Record<string, "delete" | "yank" | "change">> = {
  d: "delete",
  x: "delete",
  y: "yank",
  c: "change",
};

/** Two-key commands: the first key, and what the second (the same key) completes. */
const DOUBLED: Readonly<Record<string, VimAction>> = {
  g: { type: "move", motion: "doc-start" },
  d: { type: "delete-line" },
  y: { type: "yank-line" },
};

/** Keys with a long name that would still edit the text if let through. */
const EDITING_KEYS = new Set(["Enter", "Backspace", "Delete", "Tab"]);

const PASS: Interpreted = { action: { type: "pass" }, pending: "" };
const SWALLOW: Interpreted = { action: { type: "swallow" }, pending: "" };

const done = (action: VimAction): Interpreted => ({ action, pending: "" });

function visualKey(mode: "visual" | "visual-line", key: string): Interpreted {
  if (key === "Escape") {
    return done({ type: "normal" });
  }
  const op = OPERATORS[key];
  if (op) {
    return done({ type: "operate", op });
  }
  if (key === "v" || key === "V") {
    const linewise = key === "V";
    return done(
      linewise === (mode === "visual-line") ? { type: "normal" } : { type: "visual", linewise },
    );
  }
  return SWALLOW;
}

export function interpretKey(mode: VimMode, pending: string, input: VimKey): Interpreted {
  const { key } = input;
  if (mode === "insert") {
    return key === "Escape" && !input.ctrl && !input.meta && !input.alt
      ? done({ type: "normal" })
      : PASS;
  }
  if (input.alt) {
    return PASS;
  }
  if (input.meta || input.ctrl) {
    // The editor's own undo keys: not editable outside insert, it no longer sees them
    if (mode === "normal" && (key === "z" || key === "Z") && !input.alt) {
      return done({ type: key === "z" ? "undo" : "redo" });
    }
    return mode === "normal" && input.ctrl && !input.meta && key === "r"
      ? done({ type: "redo" })
      : PASS;
  }
  if (pending) {
    const doubled = DOUBLED[pending];
    return pending === key && doubled ? done(doubled) : SWALLOW;
  }
  const motion = MOTIONS[key];
  if (motion) {
    return done({ type: "move", motion });
  }
  if (key === "g" || (mode === "normal" && (key === "d" || key === "y"))) {
    return { action: { type: "swallow" }, pending: key };
  }
  if (mode !== "normal") {
    return key.length === 1 || EDITING_KEYS.has(key) || key === "Escape"
      ? visualKey(mode, key)
      : PASS;
  }
  if (key === "Escape") {
    return PASS;
  }
  const at = INSERTS[key];
  if (at) {
    return done({ type: "insert", at });
  }
  const action = NORMAL[key];
  if (action) {
    return done(action);
  }
  return key.length === 1 || EDITING_KEYS.has(key) ? SWALLOW : PASS;
}

/** Digits by their physical key, for the two Vim needs. The rest of the row means nothing here. */
const SHIFTED_DIGITS: Readonly<Record<string, string>> = { Digit4: "$" };

/**
 * The key as Vim reads it. While an IME holds the key (WebKit names it "Process"), the
 * physical key decides: a Japanese IME left on in normal mode would otherwise eat `j`.
 */
export function keyOf(e: KeyboardEvent): VimKey {
  let { key } = e;
  if (isImeComposing(e) || key === "Process") {
    if (e.code.startsWith("Key")) {
      const letter = e.code.slice(3).toLowerCase();
      key = e.shiftKey ? letter.toUpperCase() : letter;
    } else if (e.code.startsWith("Digit")) {
      key = e.shiftKey ? (SHIFTED_DIGITS[e.code] ?? "") : e.code.slice(5);
    }
  }
  return { key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };
}
