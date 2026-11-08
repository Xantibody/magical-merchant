/**
 * The part of the open note's frontmatter a person edits: its own tags and its created time.
 *
 * Kept apart from the view because reading and writing it follow rules of their own that the rest
 * of the screen never meets. The list carries tags already merged with the body's `#tag`s, so the
 * frontmatter is read on its own, only while the panel that edits it is up, and read again each
 * time so another device's edit is not written back over. A write moves the value on screen first,
 * and a tag put back from a toast has to find its note even after the selection moved on.
 */

import { createResource } from "solid-js";
import { typedInvoke } from "./commands";
import type { NoteMeta } from "./commands";
import { t } from "./i18n";

/** What the editor reads of a note. The frontmatter is filed under its filename. */
interface MetaTarget {
  filename: string;
}

export interface NoteMetaEditorDeps {
  /** Whether the panel that edits the frontmatter is on screen. Nothing is read otherwise. */
  active: () => boolean;
  selected: () => MetaTarget | undefined;
  /** Rereads the list. A row's date group and the meta line's tags come from it. */
  refreshList: () => unknown;
  showToast: (text: string) => void;
}

export interface NoteMetaEditor {
  /**
   * The frontmatter of the note on screen, never the previous one's. The resource keeps its
   * last value while the next note's is on the way, and tags edited against it would carry
   * one note's tags into another.
   */
  meta: () => NoteMeta | undefined;
  /** Whether the read failed. The panel's details say so in place of the fields. */
  failed: () => boolean;
  /**
   * Rewrites the frontmatter's tags or created time. The value on screen moves first, so a
   * second tag added before the first write lands is added to the list that has the first.
   */
  save: (item: MetaTarget, change: { time?: string; tags?: string[] }) => Promise<void>;
  /**
   * Puts a removed tag back where it stood. The note is read afresh rather than through
   * `save`: the toast outlives the selection, and `meta` may be another note's by now.
   */
  restoreTag: (filename: string, tag: string, at: number) => Promise<void>;
}

export function createNoteMetaEditor(deps: NoteMetaEditorDeps): NoteMetaEditor {
  const [noteMeta, { refetch: refetchMeta, mutate: mutateMeta }] = createResource(
    () => (deps.active() ? deps.selected()?.filename : undefined),
    async (filename) => ({ filename, meta: await typedInvoke("read_note_meta", { filename }) }),
  );

  const meta = (): NoteMeta | undefined => {
    if (noteMeta.error) {
      return undefined;
    }
    const read = noteMeta();
    return read && read.filename === deps.selected()?.filename ? read.meta : undefined;
  };

  const save = async (
    item: MetaTarget,
    change: { time?: string; tags?: string[] },
  ): Promise<void> => {
    const current = meta();
    if (!current) {
      return;
    }
    const next = { ...current, ...change };
    mutateMeta({ filename: item.filename, meta: next });
    try {
      await typedInvoke("update_note_meta", {
        filename: item.filename,
        time: next.time,
        tags: next.tags,
      });
    } catch {
      deps.showToast(t().meta.saveFailed);
      void refetchMeta();
      return;
    }
    // The created time moves the row between date groups, and the tags show on the meta line
    await deps.refreshList();
  };

  const restoreTag = async (filename: string, tag: string, at: number): Promise<void> => {
    try {
      const read = await typedInvoke("read_note_meta", { filename });
      const tags = [...read.tags.slice(0, at), tag, ...read.tags.slice(at)];
      await typedInvoke("update_note_meta", { filename, time: read.time, tags });
      if (deps.selected()?.filename === filename) {
        mutateMeta({ filename, meta: { ...read, tags } });
      }
    } catch {
      deps.showToast(t().meta.saveFailed);
      return;
    }
    await deps.refreshList();
  };

  return {
    meta,
    failed: () => Boolean(noteMeta.error),
    save,
    restoreTag,
  };
}
