/**
 * Which note of a surface's list is being looked at, and whether the body on screen is its.
 *
 * The selection is not only what was chosen. With nothing chosen, or with the chosen note gone
 * from the list, it falls back to the list's first row, so a list refetch (a sync landing a newer
 * note, a delete on another device) can move it with nobody pressing anything. Whatever holds on
 * to "the note being edited" must not read it back from here later; `lib/note-session.ts` keeps
 * its own copy for that reason.
 */

import { createMemo, createSignal } from "solid-js";
import type { Accessor, Setter } from "solid-js";

export interface NoteSelection<T extends { id: string }> {
  /** Chooses without any of the leave handling. Entries go through the view's `switchTo`. */
  setSelectedId: Setter<string | null>;
  /** The note being looked at: the chosen one, or the first row when it is not in the list. */
  selected: Accessor<T | undefined>;
  /**
   * The id of the note being looked at. Refetching the list rebuilds the item, so judging
   * "the note being looked at changed" by item identity would call it changed on every save and
   * every sync. An id does not move while the note is the same.
   */
  selectedKey: Accessor<string | undefined>;
  /**
   * Whether the body on screen belongs to the note now selected. Between moving the selection and
   * the body arriving, the previous note's title and body are still there, and characters typed
   * into them head for the next note as "the previous note's body plus what was typed". A note
   * opened for the first time has no revision either, so core cannot stop it. Every entry that
   * writes or saves checks this.
   */
  loaded: () => boolean;
}

export function createNoteSelection<T extends { id: string }>(
  items: Accessor<T[]>,
  loadedId: Accessor<string | null>,
): NoteSelection<T> {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const selected = createMemo<T | undefined>(() => {
    const list = items();
    return list.find((item) => item.id === selectedId()) ?? list[0];
  });
  const selectedKey = createMemo<string | undefined>(() => selected()?.id);
  return {
    setSelectedId,
    selected,
    selectedKey,
    loaded: () => loadedId() === selected()?.id,
  };
}
