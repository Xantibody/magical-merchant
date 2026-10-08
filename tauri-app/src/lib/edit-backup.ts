/**
 * The save decision of an edit session, and a one-slot backup local to the device.
 *
 * Insurance against a stray tap or a stray edit in a world of autosave. The body from
 * before the edit began is kept in one slot on this device only (localStorage), so
 * it can be swapped back at any time. Nothing is written to the file or the
 * frontmatter: written there it would ride the sync, and "whose restore point this
 * is" would break across devices.
 */

/** Only the part of localStorage that is used. Tests inject a memory implementation. */
export interface BackupStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface EditSession {
  /** The body at session start. Becomes the restore point. */
  readonly preEditBody: string;
  /** The body last written to the file. Saves are skipped as long as it matches. */
  lastSavedBody: string;
  /** The backup is written only once per session. */
  committed: boolean;
}

const KEY_PREFIX = "note-backup:";

export function readBackup(store: BackupStore, filename: string): string | null {
  try {
    return store.getItem(KEY_PREFIX + filename);
  } catch {
    return null;
  }
}

/**
 * Returns whether the copy actually landed. Used where the save to disk has already
 * been refused: claiming it was written and can be recalled with "restore" is
 * believed, the person closes the app, and the only copy is lost with it.
 */
export function tryWriteBackup(store: BackupStore, filename: string, body: string): boolean {
  try {
    store.setItem(KEY_PREFIX + filename, body);
    return true;
  } catch {
    // Quota exceeded, or a device where localStorage is unavailable
    return false;
  }
}

/** The backup is best-effort insurance. Failing to write it (quota etc.) must not break the main flow. */
export function writeBackup(store: BackupStore, filename: string, body: string): void {
  // If it could not be written, there is just no new restore point. The save itself succeeded
  tryWriteBackup(store, filename, body);
}

/**
 * The keystrokes the save timer is still waiting on, with the fingerprint of the body they
 * were typed over. A second slot, apart from the restore point: giving that one a fourth
 * meaning would confuse what "back to before this edit" steps back to.
 *
 * localStorage is synchronous and survives the process. The one-second debounce and the
 * IPC do not when Android puts the app away, so this is the copy that outlives that. The
 * next open of the note writes it to disk if the disk has not moved (`note-session.ts`).
 */
export interface Draft {
  body: string;
  /** The revision read before these keystrokes. `undefined` when the note had none yet. */
  revision: string | undefined;
}

const DRAFT_PREFIX = "note-draft:";

export function readDraft(store: BackupStore, filename: string): Draft | null {
  try {
    const raw = store.getItem(DRAFT_PREFIX + filename);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !("body" in parsed)) {
      return null;
    }
    const { body, revision } = parsed as { body: unknown; revision?: unknown };
    if (typeof body !== "string") {
      return null;
    }
    return { body, revision: typeof revision === "string" ? revision : undefined };
  } catch {
    return null;
  }
}

/** Best-effort, like the backup: a draft that could not be kept is just no draft. */
export function writeDraft(store: BackupStore, filename: string, draft: Draft): void {
  try {
    store.setItem(DRAFT_PREFIX + filename, JSON.stringify(draft));
  } catch {
    // Quota exceeded, or a device where localStorage is unavailable
  }
}

export function clearDraft(store: BackupStore, filename: string): void {
  try {
    store.removeItem(DRAFT_PREFIX + filename);
  } catch {
    // Nothing to clear on a device where localStorage is unavailable
  }
}

export function beginEditSession(body: string): EditSession {
  return { preEditBody: body, lastSavedBody: body, committed: false };
}

/** No save that would not change the content. A stray tap does not become a write. */
export function shouldSave(session: EditSession, body: string): boolean {
  return body !== session.lastSavedBody;
}

/**
 * Called when a save succeeded. Only on the first save that actually changed the
 * content is the pre-edit body kept in the backup. A session with no change writes
 * nothing, so that the single restore slot is not crushed with "the same body as now".
 */
export function recordSaved(
  store: BackupStore,
  filename: string,
  session: EditSession,
  body: string,
): void {
  if (!session.committed && body !== session.preEditBody) {
    writeBackup(store, filename, session.preEditBody);
    session.committed = true;
  }
  session.lastSavedBody = body;
}
