/**
 * The open note's body as the screen holds it: the title field, the editor's body, the view
 * mode, which note they belong to and how many times they were replaced from outside.
 *
 * Kept apart from the view because these five move together. A body shown without its mode draws
 * a moment in the wrong mode, a body shown without advancing the epoch leaves the editor on the
 * previous document, and one shown without its id stays unwritable. `show` is the one place that
 * replaces them, so they cannot drift apart.
 */

import { batch, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import { joinTitle } from "./note-title";
import type { NoteView } from "./note-view";

export interface NoteBuffer {
  /**
   * The body with the leading H1 split off. The editor writes it back on every keystroke, so it is
   * always the body on screen: the preview at the moment it switches to read-only, and the map,
   * both get the body as it was typed a moment earlier by reading this.
   */
  body: Accessor<string>;
  setBody: (body: string) => void;
  /** The H1 at the top of the body. The title field edits it, and every save writes it back. */
  title: Accessor<string>;
  setTitle: (title: string) => void;
  view: Accessor<NoteView>;
  /** Switches the mode alone. A body stays where it is. */
  setView: (view: NoteView) => void;
  /** The id of the note whose body has finished loading. `?edit=1` autofocus waits on it. */
  loadedId: Accessor<string | null>;
  /**
   * How many times the body was replaced from outside. The editor holds its own document as the
   * truth, so when the body on screen changes because another note was opened, sync brought one
   * down, or an edit was reverted, the only option is to rebuild it (inserting the body breaks the
   * cursor, the selection and the IME). This value is the key it is rebuilt on.
   *
   * It is at the same time the name of "the current load session". One value maps to exactly one
   * `show`, that is one load of one note, so while they match, what is on screen is the body
   * shown then and the keystrokes after it. The backup of a refused save (`typedBody`) reads it.
   */
  epoch: Accessor<number>;
  /**
   * The body written to the file. The title field and the editor are shown separately, but saving,
   * the backup and the mindmap always handle the joined whole.
   */
  full: () => string;
  /** Replaces the whole body. Title, body and mode are set at once and the editor is rebuilt. */
  show: (id: string, title: string, body: string, view: NoteView) => void;
  /** The body on screen is nobody's until the next `show`. Title and body become unwritable. */
  unload: () => void;
}

export function createNoteBuffer(): NoteBuffer {
  const [body, setBody] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [view, setView] = createSignal<NoteView>("editor");
  const [loadedId, setLoadedId] = createSignal<string | null>(null);
  const [epoch, setEpoch] = createSignal(1);

  return {
    body,
    setBody,
    title,
    setTitle,
    view,
    setView,
    loadedId,
    epoch,
    full: () => joinTitle(title(), body()),
    show: (id, nextTitle, nextBody, nextView) => {
      batch(() => {
        setTitle(nextTitle);
        setBody(nextBody);
        setView(nextView);
        setLoadedId(id);
        setEpoch((current) => current + 1);
      });
    },
    unload: () => setLoadedId(null),
  };
}
