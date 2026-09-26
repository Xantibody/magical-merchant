import { describe, it, expect, onTestFinished, vi } from "vitest";
import { createNoteSession } from "./note-session";
import type { NoteSession, PendingSave, SaveStatus, SaveTarget } from "./note-session";
import type { BackupStore } from "./edit-backup";
import type { NoteContent } from "./note-view";
import { t } from "./i18n";

const NOTE: SaveTarget = {
  id: "20260919_101010.md",
  filename: "20260919_101010.md",
  title: "歩いた日",
};
const OTHER: SaveTarget = {
  id: "20260919_202020.md",
  filename: "20260919_202020.md",
  title: "読んだ本",
};

const refusal = (kind: string): unknown => ({ kind, message: kind });

/** Where backups are kept. A failure can be injected too, to make a device that cannot write. */
function memoryStore(broken = false): BackupStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      if (broken) {
        throw new Error("quota");
      }
      items.set(key, value);
    },
  };
}

interface Harness {
  session: NoteSession;
  /** The writes that actually went to disk. */
  writes: { filename: string; body: string; revision: string }[];
  toasts: string[];
  statuses: SaveStatus[];
  /** The bodies put on screen, one per `showBody` call. */
  shown: { id: string; title: string; body: string }[];
  refreshes: number;
  saved: number;
  store: ReturnType<typeof memoryStore>;
  /** The screen state. The tests move it directly. */
  view: {
    selected: SaveTarget | undefined;
    loaded: boolean;
    body: string;
    bodyEpoch: number;
    focus: boolean;
  };
  /** The body the next read returns. null makes the read fail. */
  disk: { content: NoteContent | null };
  /** The reason the next write is refused. null lets it write. */
  refuse: { error: unknown };
}

function harness(options: { store?: ReturnType<typeof memoryStore> } = {}): Harness {
  // Move past the 1 second debounce without waiting. Cleanup happens per test
  vi.useFakeTimers();
  onTestFinished(() => vi.useRealTimers());

  const store = options.store ?? memoryStore();
  const writes: Harness["writes"] = [];
  const toasts: string[] = [];
  const statuses: SaveStatus[] = [];
  const shown: Harness["shown"] = [];
  const view: Harness["view"] = {
    selected: NOTE,
    loaded: true,
    body: "# 歩いた日\n\n三丁目まで",
    bodyEpoch: 1,
    focus: false,
  };
  const disk: Harness["disk"] = {
    content: { body: "# 歩いた日\n\nディスクのぶん", view: "editor", revision: "r-disk" },
  };
  const refuse: Harness["refuse"] = { error: null };
  const counts = { refreshes: 0, saved: 0 };

  const session = createNoteSession({
    selected: () => view.selected,
    loaded: () => view.loaded,
    body: () => view.body,
    bodyEpoch: () => view.bodyEpoch,
    bodyHasFocus: () => view.focus,
    store,
    read: (filename) =>
      disk.content
        ? Promise.resolve(disk.content)
        : Promise.reject(new Error(`cannot read ${filename}`)),
    write: (filename, body, revision) => {
      if (refuse.error) {
        return Promise.reject(refuse.error);
      }
      writes.push({ filename, body, revision });
      return Promise.resolve(`r-${writes.length}`);
    },
    showBody: (id, title, body) => {
      shown.push({ id, title, body });
      // As on the real screen, putting a body up advances the epoch by one
      view.bodyEpoch += 1;
      view.body = title ? `${title}\n\n${body}` : body;
    },
    refreshList: () => {
      counts.refreshes += 1;
    },
    setStatus: (status) => statuses.push(status),
    onSaved: () => {
      counts.saved += 1;
    },
    showToast: (text) => toasts.push(text),
  });

  return {
    session,
    writes,
    toasts,
    statuses,
    shown,
    store,
    view,
    disk,
    refuse,
    get refreshes() {
      return counts.refreshes;
    },
    get saved() {
      return counts.saved;
    },
  };
}

/** Put it in the state of one character typed. This is the entry point for saving. */
function keystroke(h: Harness, body: string): void {
  h.session.ensure();
  h.view.body = body;
  h.session.schedule();
}

/** Type one character into a note that has been read. A note with no fingerprint is never saved. */
function typed(h: Harness, body: string): void {
  h.session.setRevision(NOTE.filename, "r-read");
  keystroke(h, body);
}

describe("自動保存の予約", () => {
  it("writes once the typing pauses, with the revision it read", async () => {
    const h = harness();
    typed(h, "# 歩いた日\n\n四丁目まで");

    expect(h.writes).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([
      { filename: NOTE.filename, body: "# 歩いた日\n\n四丁目まで", revision: "r-read" },
    ]);
    expect(h.saved).toBe(1);
  });

  // Do not turn a stray tap into a write. Writing the same content only moves mtime
  it("skips a save whose body never changed", async () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");
    h.session.ensure();
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([]);
  });

  /**
   * Writing to a note with no fingerprint slips past core's check and puts the whole
   * screen body over a body that was never read
   */
  it("writes nothing to a note it has no fingerprint for", async () => {
    const h = harness();
    h.session.ensure();
    h.view.body = "打った";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([]);
  });

  // Take no snapshot of a note whose body has not arrived. What is on screen is the previous note
  it("takes no snapshot before the body has arrived", async () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");
    h.view.loaded = false;
    h.session.ensure();
    h.view.body = "前のノートの本文 + 打った字";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes).toStrictEqual([]);
  });

  // The snapshot is retaken on every keystroke, so only the last one runs
  it("collapses a run of keystrokes into the last snapshot", async () => {
    const h = harness();
    typed(h, "一");
    await vi.advanceTimersByTimeAsync(400);
    typed(h, "一二");
    await vi.advanceTimersByTimeAsync(400);
    typed(h, "一二三");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes.map((write) => write.body)).toStrictEqual(["一二三"]);
  });

  it("reports saving and hands the landing to the screen", async () => {
    const h = harness();
    typed(h, "打った");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.statuses).toStrictEqual(["saving"]);
    expect(h.saved).toBe(1);
  });

  // On a device that writes slowly, the save lands after the move to the next note
  it("keeps a late save's landing off the note opened after it", async () => {
    const h = harness();
    typed(h, "打った");
    h.view.selected = OTHER;
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes.map((write) => write.filename)).toStrictEqual([NOTE.filename]);
    expect(h.saved).toBe(0);
    expect(h.statuses).toStrictEqual([]);
  });
});

describe("isTyping", () => {
  it("is true while a save is still owed to the disk", async () => {
    const h = harness();
    expect(h.session.isTyping()).toBe(false);

    typed(h, "打った");
    expect(h.session.isTyping()).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.session.isTyping()).toBe(false);
  });

  it("is true while the caret sits in the body", () => {
    const h = harness();
    h.view.focus = true;

    expect(h.session.isTyping()).toBe(true);
  });
});

describe("読み直し", () => {
  it("puts the body on screen and remembers its fingerprint", async () => {
    const h = harness();

    await expect(h.session.reload(NOTE)).resolves.toBe(true);
    expect(h.shown).toStrictEqual([{ id: NOTE.id, title: "歩いた日", body: "ディスクのぶん" }]);
    expect(h.session.revisionOf(NOTE.filename)).toBe("r-disk");
  });

  // Replacing the body destroys the caret, the selection and the IME with it
  it("leaves the body alone while it is being written", async () => {
    const h = harness();
    h.view.focus = true;

    await expect(h.session.reload(NOTE)).resolves.toBe(false);
    expect(h.shown).toStrictEqual([]);
    expect(h.session.revisionOf(NOTE.filename)).toBeUndefined();
  });

  it("yields anyway once the draft has been put somewhere safe", async () => {
    const h = harness();
    h.view.focus = true;

    await expect(h.session.reload(NOTE, true)).resolves.toBe(true);
    expect(h.shown).toHaveLength(1);
  });

  // Stepping quickly down the list, a slow read overtakes a fast one and arrives out of order
  it("drops an answer for a note that is no longer selected", async () => {
    const h = harness();
    const reloading = h.session.reload(NOTE);
    h.view.selected = OTHER;

    await expect(reloading).resolves.toBe(false);
    expect(h.shown).toStrictEqual([]);
    expect(h.session.revisionOf(NOTE.filename)).toBeUndefined();
  });

  // Do not turn a failed read into a body swap. Showing the note as empty does more harm
  it("says so instead of emptying the body when the read fails", async () => {
    const h = harness();
    h.disk.content = null;

    await expect(h.session.reload(NOTE)).resolves.toBe(false);
    expect(h.shown).toStrictEqual([]);
    expect(h.toasts).toStrictEqual([t().notes.loadFailed]);
  });
});

describe("外からの書き換えに譲る", () => {
  const stale = refusal("stale");

  it("backs up the draft, reloads the disk body and names what happened", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
    expect(h.shown).toHaveLength(1);
    expect(h.toasts).toStrictEqual([t().notes.editedElsewhere]);
  });

  /**
   * What is backed up is what is on screen now, not the snapshot that was sent. Characters
   * typed during the IPC round trip are in neither the file nor the backup yet
   */
  it("keeps the keystrokes that landed during the round trip", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    const flushing = vi.advanceTimersByTimeAsync(1000);
    h.view.body = "打った、さらに打った";
    await flushing;

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った、さらに打った");
  });

  // If the screen body has been replaced, the snapshot is what gets backed up
  it("backs up the snapshot once the screen body has been replaced", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    const flushing = vi.advanceTimersByTimeAsync(1000);
    h.view.bodyEpoch += 1;
    h.view.body = "別の読み込みで載ったぶん";
    await flushing;

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
  });

  // If the screen moved to the next note during the round trip, the disk body cannot be poured in
  it("does not reload into a note the screen has left", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = stale;
    const flushing = vi.advanceTimersByTimeAsync(1000);
    h.view.selected = OTHER;
    await flushing;

    expect(h.shown).toStrictEqual([]);
    expect(h.toasts).toStrictEqual([t().notes.editedElsewhereAway(NOTE.title)]);
  });

  // Saying Revert can bring it back when no backup was kept makes people believe it and close
  it("promises no Revert when the backup cannot be written", async () => {
    const h = harness({ store: memoryStore(true) });
    typed(h, "打った");
    h.refuse.error = stale;
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.toasts).toStrictEqual([t().notes.saveNotKept]);
    expect(h.view.body).toBe("打った");
    expect(h.shown).toStrictEqual([]);
  });

  /**
   * A snapshot queued before the yield comes up for its turn knowing nothing of the
   * reloaded version. Writing it as is puts an old draft over the other body now on
   * screen, and core cannot stop it either, because the fingerprint is new
   */
  it("drops a save that was queued before the yield", async () => {
    const h = harness();
    typed(h, "打った");
    const queued = h.session.snapshotFor(NOTE);
    h.refuse.error = stale;
    await vi.advanceTimersByTimeAsync(1000);
    h.refuse.error = null;

    await h.session.flush(queued);

    expect(h.writes).toStrictEqual([]);
  });
});

describe("読み直しでは直らない拒否", () => {
  it("backs up the draft and does not reload", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = refusal("broken");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
    expect(h.shown).toStrictEqual([]);
    expect(h.toasts).toStrictEqual([t().notes.brokenMeta]);
    expect(h.statuses).toStrictEqual(["saving", "idle"]);
  });

  it("backs up and reports an unnamed failure without waiting for another keystroke", async () => {
    const h = harness();
    typed(h, "打った");
    h.refuse.error = new Error("network");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("打った");
    expect(h.toasts).toStrictEqual([t().notes.saveFailedKept(NOTE.title)]);
  });
});

describe("離れる手前", () => {
  it("flushes the pending save and refreshes the list once", async () => {
    const h = harness();
    typed(h, "打った");

    await h.session.settleEdit();

    expect(h.writes.map((write) => write.body)).toStrictEqual(["打った"]);
    expect(h.refreshes).toBe(1);
  });

  // If nothing was saved, the title shown in the row has not changed either
  it("does not refresh the list when nothing was written", async () => {
    const h = harness();

    await h.session.settleEdit();

    expect(h.refreshes).toBe(0);
  });

  // Even when an autosave has already landed, the row must not be left with the old title
  it("refreshes the list after an autosave has already landed", async () => {
    const h = harness();
    typed(h, "打った");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.refreshes).toBe(0);

    await h.session.settleEdit();

    expect(h.refreshes).toBe(1);
  });

  /**
   * The selection can move without passing through here: `selected` falls back to the list's
   * first row, and a sync that lands a newer note (or deletes this one) moves it. The keystrokes
   * belong to the note they were typed into, not to whatever is selected when the leave comes
   */
  it("writes the typed note even after the selection has already moved", async () => {
    const h = harness();
    typed(h, "打った");
    h.view.selected = OTHER;
    h.view.loaded = false;

    await h.session.settleEdit();

    expect(h.writes).toStrictEqual([
      { filename: NOTE.filename, body: "打った", revision: "r-read" },
    ]);
  });

  it("does not write the next note's body into it once that body has arrived", async () => {
    const h = harness();
    typed(h, "打った");
    h.session.setRevision(OTHER.filename, "r-other");
    h.view.selected = OTHER;
    h.view.body = "# 読んだ本\n\n別のノート";
    h.view.bodyEpoch += 1;

    await h.session.settleEdit();

    expect(h.writes).toStrictEqual([
      { filename: NOTE.filename, body: "打った", revision: "r-read" },
    ]);
  });

  // A write that lands after a rename goes to the path from before the move
  it("waits for a write that is still in flight", async () => {
    const h = harness();
    typed(h, "打った");
    const inFlight = h.session.flush();

    await h.session.settleWrites();

    await expect(inFlight).resolves.toBeUndefined();
    expect(h.writes).toHaveLength(1);
  });
});

describe("編集セッション", () => {
  // There is one slot to go back to. Do not overwrite it with a body that is not the pre-edit one
  it("keeps the pre-edit body as the one step back across several saves", async () => {
    const h = harness();
    typed(h, "一");
    await vi.advanceTimersByTimeAsync(1000);
    typed(h, "一二");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("# 歩いた日\n\n三丁目まで");
  });

  // Close the session on a move to another note. A back target left on the previous note
  // overwrites that note's backup
  it("opens a new session for the next note after a drop", async () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");
    h.session.ensure();
    h.session.drop();
    h.view.body = "畳んだあとの本文";
    h.session.ensure();
    h.view.body = "そこから打った";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("畳んだあとの本文");
  });

  // Unless it reopens as a session whose backup is already taken, pressing again cannot go back
  it("does not overwrite the backup it just handed out", async () => {
    const h = harness();
    h.store.items.set(`note-backup:${NOTE.filename}`, "戻す前");
    h.session.setRevision(NOTE.filename, "r-read");
    h.session.reopenAt(NOTE.filename, "戻した本文");
    h.view.body = "戻した本文、から打った";
    h.session.schedule();
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.store.items.get(`note-backup:${NOTE.filename}`)).toBe("戻す前");
  });
});

describe("指紋", () => {
  it("forgets the fingerprint so the next save is refused instead of overwriting", () => {
    const h = harness();
    h.session.setRevision(NOTE.filename, "r-read");

    h.session.forgetRevision(NOTE.filename);

    expect(h.session.revisionOf(NOTE.filename)).toBeUndefined();
  });

  it("carries the revision the write returned into the next save", async () => {
    const h = harness();
    typed(h, "一");
    await vi.advanceTimersByTimeAsync(1000);
    // The second keystroke did not reload. What it carries is the fingerprint the first write returned
    keystroke(h, "一二");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.writes.map((write) => write.revision)).toStrictEqual(["r-read", "r-1"]);
  });
});

describe("画面を閉じるとき", () => {
  it("still writes what was typed", async () => {
    const h = harness();
    typed(h, "打った");

    h.session.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.writes.map((write) => write.body)).toStrictEqual(["打った"]);
  });

  it("writes what was typed into the note it was typed into", async () => {
    const h = harness();
    typed(h, "打った");
    h.view.selected = OTHER;
    h.view.loaded = false;

    h.session.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.writes).toStrictEqual([
      { filename: NOTE.filename, body: "打った", revision: "r-read" },
    ]);
  });

  it("writes nothing when the disk is already up to date", async () => {
    const h = harness();

    h.session.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.writes).toStrictEqual([]);
  });
});

describe("snapshotFor", () => {
  // The refusal path of Revert takes the snapshot after the screen has made its decision
  it("snapshots a note the screen has already vouched for", () => {
    const h = harness();
    h.view.body = "いまの本文";

    const pending: PendingSave = h.session.snapshotFor(NOTE);

    expect(pending.item).toBe(NOTE);
    expect(pending.body).toBe("いまの本文");
    expect(pending.bodyEpoch).toBe(h.view.bodyEpoch);
  });
});
