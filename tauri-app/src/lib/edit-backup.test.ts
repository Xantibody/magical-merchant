import { describe, it, expect } from "vitest";
import {
  beginEditSession,
  clearDraft,
  readBackup,
  readDraft,
  recordSaved,
  shouldSave,
  tryWriteBackup,
  writeBackup,
  writeDraft,
} from "./edit-backup";
import type { BackupStore } from "./edit-backup";

function memoryStore(): BackupStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const FILE = "20260816_001122.md";

describe("shouldSave", () => {
  it("skips the save while nothing changed since the last write", () => {
    const session = beginEditSession("# メモ");

    expect(shouldSave(session, "# メモ")).toBe(false);
  });

  it("saves once the draft differs from the last written body", () => {
    const session = beginEditSession("# メモ");

    expect(shouldSave(session, "# メモ!")).toBe(true);
  });

  it("skips again after the changed body has been written", () => {
    const store = memoryStore();
    const session = beginEditSession("# メモ");

    recordSaved(store, FILE, session, "# メモ!");

    expect(shouldSave(session, "# メモ!")).toBe(false);
  });
});

describe("recordSaved", () => {
  it("stores the pre-edit body on the first content-changing save", () => {
    const store = memoryStore();
    const session = beginEditSession("# 元の本文");

    recordSaved(store, FILE, session, "# 書き換えた本文");

    expect(readBackup(store, FILE)).toBe("# 元の本文");
  });

  it("keeps the session-start snapshot across later saves", () => {
    const store = memoryStore();
    const session = beginEditSession("v1");

    recordSaved(store, FILE, session, "v2");
    recordSaved(store, FILE, session, "v3");

    expect(readBackup(store, FILE)).toBe("v1");
  });

  // If a session with no change crushed the single backup slot with "the same
  // body as now", the restore point would be gone
  it("does not touch the backup when the saved body equals the pre-edit body", () => {
    const store = memoryStore();
    writeBackup(store, FILE, "昔の本文");
    const session = beginEditSession("今の本文");

    recordSaved(store, FILE, session, "今の本文");

    expect(readBackup(store, FILE)).toBe("昔の本文");
  });

  it("a new session replaces the previous backup", () => {
    const store = memoryStore();
    const first = beginEditSession("v1");
    recordSaved(store, FILE, first, "v2");

    const second = beginEditSession("v2");
    recordSaved(store, FILE, second, "v3");

    expect(readBackup(store, FILE)).toBe("v2");
  });
});

describe("readBackup / writeBackup", () => {
  it("returns null when the note has no backup", () => {
    expect(readBackup(memoryStore(), FILE)).toBeNull();
  });

  it("round-trips a swap: write current, read old, and back again", () => {
    const store = memoryStore();
    writeBackup(store, FILE, "編集前");

    const backup = readBackup(store, FILE);
    writeBackup(store, FILE, "編集後");

    expect(backup).toBe("編集前");
    expect(readBackup(store, FILE)).toBe("編集後");
  });

  // The backup is best-effort insurance. Failing to write it (quota etc.) must
  // not break the main flow of saving and restoring
  it("swallows storage failures", () => {
    const broken: BackupStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(() => writeBackup(broken, FILE, "本文")).not.toThrow();
    expect(readBackup(broken, FILE)).toBeNull();
  });

  // Where the save to disk has already been refused, we must know whether the
  // backup failed too. Claiming it was written would announce it can be recalled with "restore"
  it("reports whether the copy actually landed", () => {
    const broken: BackupStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(tryWriteBackup(memoryStore(), FILE, "本文")).toBe(true);
    expect(tryWriteBackup(broken, FILE, "本文")).toBe(false);
  });
});

// The keystrokes the save timer is still waiting on. localStorage is synchronous and
// survives the process, which the one-second debounce and the IPC do not when Android
// puts the app away
describe("readDraft / writeDraft / clearDraft", () => {
  it("keeps the typed body together with the revision it was typed over", () => {
    const store = memoryStore();

    writeDraft(store, FILE, { body: "# メモ\n\n続き", revision: "r-1" });

    expect(readDraft(store, FILE)).toStrictEqual({ body: "# メモ\n\n続き", revision: "r-1" });
  });

  it("has nothing for a note never typed into", () => {
    expect(readDraft(memoryStore(), FILE)).toBeNull();
  });

  it("is gone once cleared", () => {
    const store = memoryStore();
    writeDraft(store, FILE, { body: "# メモ", revision: "r-1" });

    clearDraft(store, FILE);

    expect(readDraft(store, FILE)).toBeNull();
  });

  it("is a different slot from the restore point", () => {
    const store = memoryStore();
    writeBackup(store, FILE, "before");

    writeDraft(store, FILE, { body: "after", revision: "r-1" });

    expect(readBackup(store, FILE)).toBe("before");
  });

  // A value a past build wrote, or a hand-edited one. Not a crash, just no draft
  it("treats a slot it cannot read as empty", () => {
    const store = memoryStore();
    store.setItem(`note-draft:${FILE}`, "{not json");

    expect(readDraft(store, FILE)).toBeNull();
  });
});
