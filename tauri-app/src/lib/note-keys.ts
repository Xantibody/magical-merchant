/**
 * The keys that act on the open note, as a table, and the plain key that opens the writing
 * screen. Workspace's key handler tries the rows in order, and the first whose key matches runs.
 *
 * A table for the same reason as AppLayout's (`shell-commands.ts`): a chain of branches hid which
 * key does what behind its control flow, and the one key that only works on a Codex hid its
 * condition inside its branch.
 */

import { isImeComposing } from "./ime";
import type { NoteItem } from "./items";
import { isTypingTarget } from "./shortcuts";
import type { ShortcutName } from "./shortcuts";

export interface NoteKey {
  shortcut: ShortcutName;
  /** Absent when the key works on every note. */
  when?: () => boolean;
  run: (item: NoteItem) => unknown;
}

export interface NoteKeyDeps {
  togglePanel: () => void;
  toggleMap: (item: NoteItem) => unknown;
  revertEdit: (item: NoteItem) => unknown;
  /** The panel docked on its settings tab with the details unfolded. */
  openDetails: () => void;
  commitVersion: (item: NoteItem) => unknown;
  toggleHistory: () => void;
  /** Only a Codex has a history. On a Note its key passes through. */
  isCodex: () => boolean;
}

export function noteKeys(deps: NoteKeyDeps): NoteKey[] {
  return [
    { shortcut: "noteActions", run: deps.togglePanel },
    { shortcut: "noteMap", run: deps.toggleMap },
    { shortcut: "noteRevert", run: deps.revertEdit },
    { shortcut: "noteInfo", run: deps.openDetails },
    { shortcut: "codexCommit", run: deps.commitVersion },
    { shortcut: "noteHistory", when: deps.isCodex, run: deps.toggleHistory },
  ];
}

/**
 * Enter or e in the viewer opens the writing screen. Not when the key belongs to something
 * else: a field, a focused button or link, or the palette (AppLayout closes it on the same Esc
 * this handler sees next, so its target is what tells).
 */
export function isWriteKey(e: KeyboardEvent, writing: boolean): boolean {
  if (writing || e.metaKey || e.ctrlKey || e.altKey || isImeComposing(e)) {
    return false;
  }
  if (e.key !== "Enter" && e.key !== "e") {
    return false;
  }
  const target = e.target instanceof Element ? e.target : null;
  return !isTypingTarget(e.target) && !target?.closest("button, a, [role='dialog']");
}
