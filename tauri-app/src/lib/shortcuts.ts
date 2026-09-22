/**
 * The table of actions that can be called from the keyboard. The key matching, the badge
 * floated at a button's shoulder (`data-hint-key`) and what the palette prints at its
 * right edge are all handed out from here. Writing the same "⌘N" in three places leaves a
 * lying badge behind when only one of them is fixed.
 *
 * The modifier is spelled ⌘ on macOS and Ctrl elsewhere, but matching accepts both: with
 * an external keyboard or a browser on Android there is no telling which one arrives.
 */

import { isMacDesktop } from "./platform";

interface Shortcut {
  /** `e.key` lowercased. */
  key: string;
  shift?: boolean;
}

const SHORTCUTS = {
  search: { key: "k" },
  newNote: { key: "n" },
  scrawl: { key: "1" },
  notes: { key: "2" },
  codex: { key: "3" },
  // The screen that narrows by kind / tag / period. Typing to find something is ⌘K's job
  browse: { key: "f" },
  syncNow: { key: "s", shift: true },
  settings: { key: "," },
  // Make the list flyout permanent. It does not fold away when the pointer leaves
  listPin: { key: "\\" },
  // These work on the open note. Workspace takes them, and they can be pressed only
  // while one note is open
  noteActions: { key: "." },
  noteMap: { key: "m", shift: true },
  // ⌘⇧ plus the initial. ⌘Z / ⌘⇧Z (redo) and ⌘I (italic) belong to Milkdown and cannot be
  // taken while the caret is in the always-editable body (#211)
  noteRevert: { key: "r", shift: true },
  noteInfo: { key: "i", shift: true },
  // The K of "commit a version". ⇧ separates it from ⌘K (search). Only while a Codex is open
  codexCommit: { key: "k", shift: true },
  // The history panel. It never opens on hover, so the button and this are the only ways in
  noteHistory: { key: "h", shift: true },
  notePrev: { key: "arrowup" },
  noteNext: { key: "arrowdown" },
} as const satisfies Record<string, Shortcut>;

/** An arrow key's own name does not read. These are the spellings the badge prints. */
const PRINTED: Partial<Record<string, string>> = {
  arrowup: "↑",
  arrowdown: "↓",
};

export type ShortcutName = keyof typeof SHORTCUTS;

/**
 * The key that opens the list of shortcuts. It carries no modifier, so it is taken only
 * after `isTypingTarget` has said whether something is being typed into.
 */
export const SHORTCUT_LIST_KEY = "?";

/** The name of the modifier key put into the hint text. */
export function modifierLabel(): string {
  return isMacDesktop() ? "⌘" : "Ctrl";
}

/** `⌘⇧S` / `Ctrl+Shift+S`. */
export function shortcutLabel(name: ShortcutName): string {
  const { key, shift = false } = SHORTCUTS[name] as Shortcut;
  const printed = PRINTED[key] ?? key.toUpperCase();
  return isMacDesktop()
    ? `⌘${shift ? "⇧" : ""}${printed}`
    : `Ctrl+${shift ? "Shift+" : ""}${printed}`;
}

export function matchesShortcut(e: KeyboardEvent, name: ShortcutName): boolean {
  const { key, shift = false } = SHORTCUTS[name] as Shortcut;
  return (
    (e.metaKey || e.ctrlKey) &&
    // A combination with ⌥ on it belongs to the OS and the IME. Stealing it breaks input
    !e.altKey &&
    e.shiftKey === shift &&
    e.key.toLowerCase() === key
  );
}

/** Whether a `?` pressed there becomes a character. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.closest('[contenteditable="true"], [contenteditable=""]') !== null;
}
