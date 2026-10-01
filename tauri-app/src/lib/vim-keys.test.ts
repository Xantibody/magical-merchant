import { describe, it, expect } from "vitest";
import { interpretKey, keyOf } from "./vim-keys";
import type { VimKey, VimMode } from "./vim-keys";

const key = (value: string, mods: Partial<VimKey> = {}): VimKey => ({
  key: value,
  ctrl: false,
  meta: false,
  alt: false,
  ...mods,
});

const run = (mode: VimMode, ...keys: (string | VimKey)[]) => {
  let pending = "";
  let last = interpretKey(mode, pending, key(""));
  for (const k of keys) {
    last = interpretKey(mode, pending, typeof k === "string" ? key(k) : k);
    ({ pending } = last);
  }
  return last;
};

describe("interpretKey in insert mode", () => {
  it("lets every key through", () => {
    expect(run("insert", "j").action).toStrictEqual({ type: "pass" });
  });

  it("goes to normal on Esc", () => {
    expect(run("insert", "Escape").action).toStrictEqual({ type: "normal" });
  });
});

describe("interpretKey in normal mode", () => {
  it.each([
    ["h", "left"],
    ["l", "right"],
    ["j", "down"],
    ["k", "up"],
    ["w", "word-forward"],
    ["b", "word-backward"],
    ["0", "line-start"],
    ["$", "line-end"],
    ["G", "doc-end"],
  ])("moves on %s", (k, motion) => {
    expect(run("normal", k).action).toStrictEqual({ type: "move", motion });
  });

  it("waits for a second g, then goes to the start of the document", () => {
    expect(run("normal", "g")).toStrictEqual({ action: { type: "swallow" }, pending: "g" });
    expect(run("normal", "g", "g").action).toStrictEqual({ type: "move", motion: "doc-start" });
  });

  it("drops a pending key that is not completed", () => {
    expect(run("normal", "d", "j")).toStrictEqual({ action: { type: "swallow" }, pending: "" });
  });

  it.each([
    ["d", "delete-line"],
    ["y", "yank-line"],
  ])("takes %s twice as a whole line", (k, type) => {
    expect(run("normal", k, k).action).toStrictEqual({ type });
  });

  it.each([
    ["i", "before"],
    ["a", "after"],
    ["I", "line-start"],
    ["A", "line-end"],
    ["o", "open-below"],
    ["O", "open-above"],
  ])("enters insert on %s", (k, at) => {
    expect(run("normal", k).action).toStrictEqual({ type: "insert", at });
  });

  it.each([
    ["x", { type: "delete-char" }],
    ["p", { type: "put", before: false }],
    ["P", { type: "put", before: true }],
    ["u", { type: "undo" }],
    ["v", { type: "visual", linewise: false }],
    ["V", { type: "visual", linewise: true }],
  ])("acts on %s", (k, action) => {
    expect(run("normal", k).action).toStrictEqual(action);
  });

  it("redoes on Ctrl-r", () => {
    expect(run("normal", key("r", { ctrl: true })).action).toStrictEqual({ type: "redo" });
  });

  // Esc in normal does what it did without Vim. The editor's own keymap already takes it
  it("lets Esc through", () => {
    expect(run("normal", "Escape").action).toStrictEqual({ type: "pass" });
  });

  // The app's own shortcuts and the OS keep working in normal mode
  it.each([key("k", { meta: true }), key("f", { ctrl: true }), key("a", { alt: true })])(
    "lets a key with a modifier through",
    (k) => {
      expect(run("normal", k).action).toStrictEqual({ type: "pass" });
    },
  );

  // Nothing typed in normal mode may become text
  it.each(["q", "Z", " ", "Enter", "Backspace", "Delete", "Tab"])("swallows %j", (k) => {
    expect(run("normal", k).action).toStrictEqual({ type: "swallow" });
  });

  it.each(["Shift", "ArrowDown", "F5"])("lets the non-typing key %s through", (k) => {
    expect(run("normal", k).action).toStrictEqual({ type: "pass" });
  });
});

describe("interpretKey in visual mode", () => {
  it("moves the same way as normal", () => {
    expect(run("visual", "j").action).toStrictEqual({ type: "move", motion: "down" });
    expect(run("visual-line", "g", "g").action).toStrictEqual({
      type: "move",
      motion: "doc-start",
    });
  });

  it.each([
    ["d", "delete"],
    ["x", "delete"],
    ["y", "yank"],
    ["c", "change"],
  ])("applies %s to the selection", (k, op) => {
    expect(run("visual", k).action).toStrictEqual({ type: "operate", op });
  });

  it("leaves on Esc and takes the key", () => {
    expect(run("visual", "Escape").action).toStrictEqual({ type: "normal" });
  });

  it.each([
    ["visual", "v", { type: "normal" }],
    ["visual", "V", { type: "visual", linewise: true }],
    ["visual-line", "V", { type: "normal" }],
    ["visual-line", "v", { type: "visual", linewise: false }],
  ] as const)("in %s, %s switches to %j", (mode, k, action) => {
    expect(run(mode, k).action).toStrictEqual(action);
  });

  it("does not take insert keys", () => {
    expect(run("visual", "i").action).toStrictEqual({ type: "swallow" });
  });
});

const event = (init: KeyboardEventInit & { keyCode?: number }) => {
  const e = new KeyboardEvent("keydown", init);
  if (init.keyCode !== undefined) {
    Object.defineProperty(e, "keyCode", { value: init.keyCode });
  }
  return e;
};

describe("keyOf", () => {
  it("reads the key and the modifiers", () => {
    expect(keyOf(event({ key: "j", ctrlKey: true }))).toStrictEqual({
      key: "j",
      ctrl: true,
      meta: false,
      alt: false,
    });
  });

  // With a Japanese IME on, WebKit names the key "Process". The physical key still says which
  it.each([
    [{ code: "KeyJ" }, "j"],
    [{ code: "KeyG", shiftKey: true }, "G"],
    [{ code: "Digit0" }, "0"],
    [{ code: "Digit4", shiftKey: true }, "$"],
  ])("reads the physical key %j while an IME holds it", (init, expected) => {
    expect(keyOf(event({ key: "Process", keyCode: 229, ...init })).key).toBe(expected);
  });
});
