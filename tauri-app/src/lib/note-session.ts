/**
 * Mediation between disk and screen for the open note. Reading the body, remembering
 * the fingerprint, scheduling the autosave and yielding when refused are all kept in
 * one place. The screen (`views/Workspace.tsx`) only owns "what to show"; "when, to
 * which note, and which body to write" is decided here.
 *
 * Reading and writing live together because the two interlock through the fingerprint
 * (`revision`). A write carries the fingerprint from the read, and core refuses it when
 * they differ. Leaving the read on the screen side would route the fingerprint through
 * the whole screen, and "which body's read produced the fingerprint of this write" could
 * no longer be traced.
 *
 * The other reason to gather it here is that every decision is about a time gap. The
 * save fires 1 second late, the person moves to the next note during the IPC round
 * trip, and the CLI or another device writes the same note. Spread across the screen,
 * it is impossible to tell which path sees which gap. Typed characters that vanish
 * silently usually fall into exactly that gap.
 *
 * No dependency on Solid. Everything needed comes in through `NoteSessionDeps`.
 */

import { beginEditSession, recordSaved, shouldSave, tryWriteBackup } from "./edit-backup";
import type { BackupStore, EditSession } from "./edit-backup";
import { isStaleSave } from "./commands";
import { t } from "./i18n";
import { refusalToast } from "./save-refusal";
import type { RefusedScreen } from "./save-refusal";
import { splitTitle } from "./note-title";
import type { NoteContent, NoteView } from "./note-view";

/** Delay before the autosave fires. Writes once the typing stops. */
const SAVE_DEBOUNCE_MS = 1000;

/** Save state shown in the meta line. */
export type SaveStatus = "idle" | "saving" | "saved" | "savedAt";

/** The counterpart of the mediation. Only the part of `NoteItem` in `items.ts` seen here. */
export interface SaveTarget {
  /** Identity within the list. Same as the filename, but kept apart because the meaning differs. */
  id: string;
  filename: string;
  /** Title shown in the message when a save is refused. */
  title: string;
}

/**
 * The unit of one save. "Which note, what body, which session" is fixed at the
 * moment of the call. By the time the timer fires another note may be selected,
 * and reading the screen's body then would write it into the neighbouring note.
 */
export interface PendingSave {
  item: SaveTarget;
  body: string;
  session: EditSession;
  /** Generation at the time the copy was taken. A copy that straddles a reload is not written. */
  generation: number;
  /**
   * `bodyEpoch` at the time the copy was taken. Used after a refusal to check whether
   * the screen's body is still a continuation of this copy. The note id is not enough:
   * after A -> B -> A the ids match, yet the body is B's or a fresh reload of A.
   */
  bodyEpoch: number;
}

export interface NoteSessionDeps {
  /** The note selected now. Both reads and writes go to this target. */
  selected: () => SaveTarget | undefined;
  /** Whether the body on screen has arrived as the selected note's. */
  loaded: () => boolean;
  /** The body on screen. Title joined in, exactly what goes to the file. */
  body: () => string;
  /** How many times the body was replaced from outside. Tells whether a copy still continues. */
  bodyEpoch: () => number;
  /** Whether the cursor is in the body. The body is not replaced while someone is writing. */
  bodyHasFocus: () => boolean;
  /** Where the backup lives. Tests inject a memory implementation. */
  store: BackupStore;
  /** Reads the body, the mode and the fingerprint from disk. */
  read: (filename: string) => Promise<NoteContent>;
  /** Writes the body. Returns the fingerprint of the written body. Throws when refused. */
  write: (filename: string, body: string, revision: string) => Promise<string>;
  /** Puts the read body on screen. The only way to rebuild the editor. */
  showBody: (id: string, title: string, body: string, view: NoteView) => void;
  /** Reloads the list. The title on a row is derived from the body's first line. */
  refreshList: () => unknown;
  setStatus: (status: SaveStatus) => void;
  /** The save of the note shown on screen has landed. The screen decides how to show it. */
  onSaved: () => void;
  showToast: (text: string) => void;
}

export interface NoteSession {
  /**
   * Whether a person is writing the body right now. The editor is always open, so
   * "is edit mode on" cannot tell. Instead: are there keystrokes not yet on disk, or
   * is the cursor in the body. In either case replacing the body destroys the cursor,
   * the selection and the IME state (editor skill).
   */
  isTyping: () => boolean;
  /**
   * Reload from disk and show on screen. After a selection change and after an outside edit.
   * `force` signals "the typed characters are already backed up, so yield even mid-write".
   *
   * Returns whether the reload was actually put on screen. A failed read, and one skipped
   * because the selection moved before it arrived, return `false`. The caller can only learn
   * from here whether it landed, so that it checks before saying "reloaded".
   */
  reload: (item: SaveTarget, force?: boolean) => Promise<boolean>;
  /** Opens a session on the body just before it is edited. Not reopened while one is open. */
  ensure: () => void;
  /** Folds the session when moving to another note or when the disk body is replaced. */
  drop: () => void;
  /** Reopens as a session whose backup is already taken. Where "restore pre-edit" lands. */
  reopenAt: (filename: string, body: string) => void;
  /** Fingerprint from when the body shown on screen was read. */
  revisionOf: (filename: string) => string | undefined;
  setRevision: (filename: string, revision: string) => void;
  forgetRevision: (filename: string) => void;
  /** A copy for the given note. Used by paths that have already made the `loaded` decision. */
  snapshotFor: (item: SaveTarget) => PendingSave;
  /** Called on every keystroke. What actually runs is the copy from the last keystroke. */
  schedule: () => void;
  /**
   * Writes now. Omitting `pending` takes a copy there and then, which is right only while the
   * note typed into is still the one selected; leaving goes through `settleEdit` instead.
   */
  flush: (pending?: PendingSave) => Promise<void>;
  /** Drops the reservation. Does not write. */
  cancelPending: () => void;
  /** Reloads the list only if a save landed. Does nothing when the row titles have not moved. */
  refreshListIfStale: () => Promise<void>;
  /** Drains the waiting save before leaving. The path every selection change must go through. */
  settleEdit: () => Promise<void>;
  /** `settleEdit` before moving a file. Also waits for writes already fired to land. */
  settleWrites: () => Promise<void>;
  /** The note was edited outside between the read and the write. Yield and reload. */
  yieldToOutsideEdit: (pending: PendingSave, error: unknown) => Promise<void>;
  /** When the screen closes. Waiting saves are drained. */
  dispose: () => void;
}

export function createNoteSession(deps: NoteSessionDeps): NoteSession {
  /** The edit session open now. Holds the skip decision for saves and the backup. */
  let session = beginEditSession("");
  /** Which note that session belongs to. null means none is open. */
  let sessionFile: string | null = null;
  /**
   * Per note, the fingerprint of the body last read (or written). Attached to a save,
   * it makes core refuse when the CLI or MCP rewrote the note in between. Kept per note
   * because by the time a late save lands another note may be selected.
   */
  const revisions = new Map<string, string>();
  /**
   * Debounce only. An expired timer does not mean the write succeeded.
   */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let timerFile: string | undefined;
  /**
   * The copy the timer is waiting to write. A leave drains this one, not a fresh copy: by then
   * the selection may have moved without passing through `settleEdit` (a sync moves the list's
   * first row, which is what an unchosen selection falls back to), and a copy taken then would
   * drop these keystrokes or write the next note's body under this note's session.
   */
  let scheduled: PendingSave | undefined;
  let draft: PendingSave | undefined;
  /** Saves run in series. Two in flight to the same note leave "last wins" undecided. */
  let saveChain: Promise<void> = Promise.resolve();
  /**
   * Save generation. Advanced for that Note alone each time we yield to an outside edit
   * and reload. A copy queued on `saveChain` before the yield gets its turn without
   * knowing about the reloaded version. Written as is, it overwrites the other party's
   * body now on screen with an old draft, and core cannot stop it because the reload
   * has refreshed `revisions`. Matching `session.lastSavedBody` only stops "a copy of
   * the same body".
   */
  const saveGenerations = new Map<string, number>();
  const generationOf = (filename: string): number => saveGenerations.get(filename) ?? 0;
  let readGeneration = 0;
  let editGeneration = 0;
  /**
   * Whether the titles on the list rows differ from disk. Raised each time a save lands,
   * lowered on reload. Substituting "is a save waiting" skips the reload when the
   * autosave landed first, and only the row keeps the old title.
   */
  let listStale = false;

  const isTyping = (): boolean =>
    Boolean(saveTimer) ||
    deps.bodyHasFocus() ||
    (draft !== undefined &&
      draft.item.filename === deps.selected()?.filename &&
      draft.bodyEpoch === deps.bodyEpoch() &&
      shouldSave(draft.session, deps.body()));

  const cancelPending = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    timerFile = undefined;
    scheduled = undefined;
  };

  const drop = (): void => {
    sessionFile = null;
  };

  const reload = async (item: SaveTarget, force = false): Promise<boolean> => {
    const reading = ++readGeneration;
    const editing = editGeneration;
    try {
      const content = await deps.read(item.filename);
      // Stepping quickly through the list, a slow read overtakes a fast one and
      // arrives later. Only the answer for the note selected now goes on screen.
      // "Not editing and no save waiting", checked before the read started, is
      // checked again on arrival: a tap can start writing during the wait.
      // The revision is held back too, because a save with a version not shown
      // on screen could write over another party's body that was never read
      if (
        reading !== readGeneration ||
        editing !== editGeneration ||
        deps.selected()?.id !== item.id ||
        (!force && isTyping())
      ) {
        return false;
      }
      revisions.set(item.filename, content.revision);
      // Body and mode go out as a pair. Split, the wrong mode is drawn for a moment
      const titled = splitTitle(content.body);
      deps.showBody(item.id, titled.title, titled.body, content.view);
      drop();
      draft = undefined;
      return true;
    } catch {
      // A failed read must not become a body replacement. An empty editor looks
      // like an "empty note", and the few characters typed into it become the
      // whole note. `loadedId` is not advanced, so neither body nor title is writable
      if (reading === readGeneration && deps.selected()?.id === item.id && (force || !isTyping())) {
        deps.showToast(t().notes.loadFailed);
      }
      return false;
    }
  };

  const ensure = (): void => {
    const item = deps.selected();
    if (!item || sessionFile === item.filename) {
      return;
    }
    session = beginEditSession(deps.body());
    sessionFile = item.filename;
  };

  const reopenAt = (filename: string, body: string): void => {
    // Without reopening, the next touch of the title or body starts a new session,
    // whose first save writes the pre-restore body to the backup, and pressing again cannot go back
    session = beginEditSession(body);
    session.committed = true;
    sessionFile = filename;
  };

  const snapshotFor = (item: SaveTarget): PendingSave => ({
    item,
    body: deps.body(),
    session,
    generation: generationOf(item.filename),
    bodyEpoch: deps.bodyEpoch(),
  });

  const snapshot = (): PendingSave | undefined => {
    const item = deps.selected();
    // No copy of a note whose body has not arrived. What is on screen is the previous note
    return item && deps.loaded() ? snapshotFor(item) : undefined;
  };

  const refreshListIfStale = async (): Promise<void> => {
    if (!listStale) {
      return;
    }
    listStale = false;
    await deps.refreshList();
  };

  /**
   * The body to back up from a refused save. Not the copy that was sent but what is
   * on screen now: characters typed between the device's signal wait and the IPC round
   * trip are in neither the file nor the backup yet. Backing up the copy would silently
   * drop exactly those keystrokes.
   *
   * The screen's body is usable only while the load that the copy was taken from is
   * still current. `bodyEpoch` decides. Looking at the note id, a move A -> B -> A
   * during the round trip leaves the ids matching while the screen body is B's or a
   * fresh reload of A. Backing that up crushes A's backup, refused keystrokes and all,
   * with another note's body. The epoch advances each time the body is replaced from
   * outside, so when it matches the screen holds only "this copy + later keystrokes".
   */
  const typedBody = (pending: PendingSave): string =>
    deps.bodyEpoch() === pending.bodyEpoch ? deps.body() : pending.body;

  /**
   * What is on screen after a refused save. Not the state before yielding but "now",
   * after the reload is done: the read may fail and turn back, and the person may move
   * to a neighbour during the round trip, and either way the screen differs from before.
   *
   * Whether the keystrokes are still on screen is read from `bodyEpoch` (same reason as
   * `typedBody`). The epoch advances when a reload lands, but also when A -> B -> A
   * brings a different load. Both mean "the typed characters are no longer on screen",
   * so one treatment fits.
   */
  const refusedScreen = (pending: PendingSave, reloaded: boolean): RefusedScreen => {
    if (deps.selected()?.id !== pending.item.id) {
      return "away";
    }
    return reloaded || deps.bodyEpoch() !== pending.bodyEpoch ? "reloaded" : "draft";
  };

  /**
   * The CLI or MCP rewrote the same note between the read and the write. Do not write
   * over the other party's body: move the typed characters to this device's backup and
   * reload the disk body. Pressing "restore" swaps in the backed-up body, and the other
   * party's version goes to the backup, so neither is lost.
   *
   * Reload only while the yielded note is still selected. If the person moved to a
   * neighbour during the round trip, the screen holds a different note, and the disk
   * body cannot be poured into it. The message follows suit; the message for a refused
   * save is decided by `refusalToast` alone.
   */
  const yieldToOutsideEdit = async (pending: PendingSave, error: unknown): Promise<void> => {
    // Check that the backup actually landed before saying it can be recalled with
    // "restore". A full or disabled localStorage keeps nothing; a promise made there
    // is believed, and the person closes the app on it
    const kept = tryWriteBackup(deps.store, pending.item.filename, typedBody(pending));
    saveGenerations.set(pending.item.filename, generationOf(pending.item.filename) + 1);
    if (timerFile === pending.item.filename) {
      cancelPending();
    }
    let reloaded = false;
    // A failed backup leaves the editor as the only copy of these keystrokes.
    if (kept && deps.selected()?.id === pending.item.id && deps.bodyEpoch() === pending.bodyEpoch) {
      reloaded = await reload(pending.item, true);
    }
    await deps.refreshList();
    deps.showToast(refusalToast(error, kept, pending.item.title, refusedScreen(pending, reloaded)));
  };

  const flush = (pending = snapshot()): Promise<void> => {
    const previous = saveChain;
    saveChain = (async () => {
      await previous;
      // Do not turn an untouched stray tap session into a write. A write that changes
      // nothing only moves the file's mtime and triggers a sync.
      // A copy that straddles a reload is not written either (its generation was left behind)
      if (
        !pending ||
        pending.generation !== generationOf(pending.item.filename) ||
        !shouldSave(pending.session, pending.body)
      ) {
        return;
      }
      // The save state belongs to that note. On a device with slow writes it can land
      // after a move to the neighbour, and shown as is the note just opened would say
      // "saved". Show it only for the save of the note on screen
      const shown = (): boolean => deps.selected()?.id === pending.item.id;
      // Do not write a note that has no fingerprint. A save without `revision` passes
      // core's check untouched, and writes the whole screen body over a body that was
      // never read. Once a reload gets through the fingerprint is in, and the next save can write
      const expected = revisions.get(pending.item.filename);
      if (expected === undefined) {
        return;
      }
      if (shown()) {
        deps.setStatus("saving");
      }
      try {
        const revision = await deps.write(pending.item.filename, pending.body, expected);
        revisions.set(pending.item.filename, revision);
        recordSaved(deps.store, pending.item.filename, pending.session, pending.body);
        // The list is not reloaded here. Reloading every note on each 1-second save
        // is heavy on a low-end device, and the list is not even visible while editing.
        // Reload once when the writing hand stops.
        listStale = true;
        if (shown()) {
          deps.onSaved();
        }
      } catch (error) {
        if (shown()) {
          deps.setStatus("idle");
        }
        if (isStaleSave(error)) {
          await yieldToOutsideEdit(pending, error);
        } else {
          // Even a transient I/O failure may be followed by navigation instead
          // of another keystroke. Keep the draft before the screen can leave.
          const kept = tryWriteBackup(deps.store, pending.item.filename, typedBody(pending));
          // No reload runs here. The screen holds either the continuing keystrokes or another note
          deps.showToast(
            refusalToast(error, kept, pending.item.title, refusedScreen(pending, false)),
          );
        }
      }
    })();
    return saveChain;
  };

  const schedule = (): void => {
    editGeneration += 1;
    // Retaken on every keystroke, so what actually runs is the copy from the last keystroke
    const pending = snapshot();
    draft = pending;
    cancelPending();
    timerFile = pending?.item.filename;
    scheduled = pending;
    saveTimer = setTimeout(() => {
      // A fired timer is a finished timer. Without cleanup "a save is waiting" stays
      // raised, and the reload on focus return never gets through again
      saveTimer = undefined;
      timerFile = undefined;
      scheduled = undefined;
      void flush(pending);
    }, SAVE_DEBOUNCE_MS);
  };

  /** Writes the copy the timer was waiting on, now. Nothing when no save is waiting. */
  const drainScheduled = (): Promise<void> | undefined => {
    if (!saveTimer) {
      return undefined;
    }
    const pending = scheduled;
    cancelPending();
    return flush(pending);
  };

  /**
   * Drains the waiting save before leaving. The path every selection change must go
   * through. Moving without draining makes the body "next note's title + previous
   * note's body", and the next save writes that mixture into the neighbouring note.
   * The reload has already updated `revisions`, so Stale does not stop it either.
   * If nothing was saved the list is not reloaded: the row titles have not changed.
   */
  const settleEdit = async (): Promise<void> => {
    // The next write starts a new session. The restore point advances one step at a time
    drop();
    await drainScheduled();
    // The row title is derived from the body's first line. Without a reload only the
    // list keeps the old title
    await refreshListIfStale();
  };

  const settleWrites = async (): Promise<void> => {
    await settleEdit();
    await saveChain;
  };

  const dispose = (): void => {
    void drainScheduled();
  };

  return {
    isTyping,
    reload,
    ensure,
    drop,
    reopenAt,
    revisionOf: (filename) => revisions.get(filename),
    setRevision: (filename, revision) => revisions.set(filename, revision),
    forgetRevision: (filename) => revisions.delete(filename),
    snapshotFor,
    schedule,
    flush,
    cancelPending,
    refreshListIfStale,
    settleEdit,
    settleWrites,
    yieldToOutsideEdit,
    dispose,
  };
}
