import { describe, it, expect, vi, afterEach } from "vitest";
import { isWriteKey, noteKeys } from "./note-keys";
import type { NoteItem } from "./items";

function press(key: string, init: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...init });
}

/** A keydown as it arrives with `target` focused. */
function pressOn(target: Element, key: string): KeyboardEvent {
  const e = press(key);
  Object.defineProperty(e, "target", { value: target });
  return e;
}

function table(isCodex = true) {
  const deps = {
    togglePanel: vi.fn<() => void>(),
    toggleMap: vi.fn<(item: NoteItem) => void>(),
    revertEdit: vi.fn<(item: NoteItem) => void>(),
    openDetails: vi.fn<() => void>(),
    commitVersion: vi.fn<(item: NoteItem) => void>(),
    toggleHistory: vi.fn<() => void>(),
    isCodex: () => isCodex,
  };
  return { keys: noteKeys(deps), deps };
}

describe("noteKeys", () => {
  it("tries the note's keys in a fixed order", () => {
    const { keys } = table();

    expect(keys.map((key) => key.shortcut)).toStrictEqual([
      "noteActions",
      "noteMap",
      "noteRevert",
      "noteInfo",
      "codexCommit",
      "noteHistory",
    ]);
  });

  // ⌘⇧H opens the history, and only a Codex has one. On a Note the key passes through
  it("lets the history key through on a Note", () => {
    expect(
      table(true)
        .keys.find((key) => key.shortcut === "noteHistory")
        ?.when?.(),
    ).toBe(true);
    expect(
      table(false)
        .keys.find((key) => key.shortcut === "noteHistory")
        ?.when?.(),
    ).toBe(false);
  });

  it("puts no condition on the other keys", () => {
    const { keys } = table(false);

    expect(keys.filter((key) => key.when).map((key) => key.shortcut)).toStrictEqual([
      "noteHistory",
    ]);
  });

  it("hands the open note to the keys that act on it", () => {
    const { keys, deps } = table();
    const item = { id: "20260917_140300.md" } as NoteItem;

    for (const key of keys) {
      key.run(item);
    }

    expect(deps.toggleMap).toHaveBeenCalledWith(item);
    expect(deps.revertEdit).toHaveBeenCalledWith(item);
    expect(deps.commitVersion).toHaveBeenCalledWith(item);
    expect(deps.togglePanel).toHaveBeenCalledTimes(1);
    expect(deps.openDetails).toHaveBeenCalledTimes(1);
    expect(deps.toggleHistory).toHaveBeenCalledTimes(1);
  });
});

describe("isWriteKey", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("opens the writing screen on Enter and e in the viewer", () => {
    expect(isWriteKey(press("Enter"), false)).toBe(true);
    expect(isWriteKey(press("e"), false)).toBe(true);
  });

  it("does nothing once the writing screen is up", () => {
    expect(isWriteKey(press("Enter"), true)).toBe(false);
    expect(isWriteKey(press("e"), true)).toBe(false);
  });

  it("leaves other keys and modified ones alone", () => {
    expect(isWriteKey(press("E"), false)).toBe(false);
    expect(isWriteKey(press("Enter", { metaKey: true }), false)).toBe(false);
    expect(isWriteKey(press("e", { ctrlKey: true }), false)).toBe(false);
    expect(isWriteKey(press("Enter", { altKey: true }), false)).toBe(false);
  });

  // The Enter that ends a conversion is the IME's (#102)
  it("leaves the Enter that confirms an IME conversion alone", () => {
    expect(isWriteKey(press("Enter", { isComposing: true }), false)).toBe(false);
  });

  it("leaves the key to a field, a button, a link or a dialog", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    const link = document.createElement("a");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inside = document.createElement("p");
    dialog.append(inside);
    document.body.append(input, button, link, dialog);

    expect(isWriteKey(pressOn(input, "e"), false)).toBe(false);
    expect(isWriteKey(pressOn(icon, "Enter"), false)).toBe(false);
    expect(isWriteKey(pressOn(link, "Enter"), false)).toBe(false);
    expect(isWriteKey(pressOn(inside, "e"), false)).toBe(false);
  });

  it("opens from the body's plain text in the viewer", () => {
    const view = document.createElement("div");
    document.body.append(view);

    expect(isWriteKey(pressOn(view, "e"), false)).toBe(true);
  });
});
