import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { NoteKind, Version, VersionStatus } from "./commands";
import { createCodexHistory } from "./codex-history";

const FILE = "20260901_090000.md";
const DAY_MS = 86_400_000;

function version(id: string, bytes: number, time = new Date().toISOString()): Version {
  return { id, time, message: null, bytes };
}

/** What core holds for the open note. Each test rewrites it before or between calls. */
interface Disk {
  versions: Version[];
  status: VersionStatus;
  diff: string;
  /** What `commit_note_version` hands back, or how it refuses. */
  commit: Version | { kind: string; message: string };
  refuseCommit: boolean;
}

let disk: Disk;
let calls: { cmd: string; args: Record<string, unknown> }[];

function callsOf(cmd: string): Record<string, unknown>[] {
  return calls.filter((call) => call.cmd === cmd).map((call) => call.args);
}

const ANSWERS: Record<string, () => unknown> = {
  note_version_status: () => disk.status,
  list_note_versions: () => disk.versions,
  diff_note_versions: () => disk.diff,
  commit_note_version: () => {
    if (disk.refuseCommit) {
      throw disk.commit;
    }
    return disk.commit;
  },
};

function answer(cmd: string, payload: unknown): unknown {
  calls.push({ cmd, args: (payload ?? {}) as Record<string, unknown> });
  return ANSWERS[cmd]?.() ?? null;
}

/** Lets the resources run, for a test that checks nothing was read. */
function pause(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setup(initialKind: NoteKind = "codex") {
  return createRoot((dispose) => {
    const [kind, setKind] = createSignal<NoteKind>(initialKind);
    const [selected] = createSignal<{ filename: string } | undefined>({ filename: FILE });
    const [loaded, setLoaded] = createSignal(true);
    const [body] = createSignal("a\nB\nc\n");
    const toasts: { text: string; undo?: () => void; detail?: string }[] = [];
    let listRefreshes = 0;
    const history = createCodexHistory({
      kind,
      selected,
      loaded,
      body,
      refreshList: () => {
        listRefreshes += 1;
      },
      showToast: (text, undo, detail) => {
        toasts.push({ text, undo, detail });
      },
    });
    return {
      history,
      setKind,
      setLoaded,
      toasts,
      listRefreshes: () => listRefreshes,
      dispose,
    };
  });
}

type Setup = ReturnType<typeof setup>;

/** Waits until both resources have answered once, so a test starts from a read history. */
async function settled(s: Setup): Promise<void> {
  await vi.waitFor(() => {
    expect(s.history.status()).toBeDefined();
    expect(s.history.rows()).toHaveLength(disk.versions.length);
  });
}

// The words are pinned as the Japanese table spells them: `test-setup.ts` runs every test in
// Japanese, and the summary strings are part of what this file covers
describe("createCodexHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    calls = [];
    disk = {
      versions: [version("v1", 100)],
      status: { count: 1, dirty: true, bytes_delta: 20 },
      diff: "",
      commit: version("v2", 120),
      refuseCommit: false,
    };
    mockIPC(answer);
  });

  afterEach(() => {
    clearMocks();
  });

  describe("読み込み", () => {
    it("reads nothing while the note is not a Codex", async () => {
      const s = setup("notes");
      await pause(50);

      expect(calls).toStrictEqual([]);
      expect(s.history.status()).toBeUndefined();
      expect(s.history.rows()).toStrictEqual([]);
      expect(s.history.canCommit()).toBe(false);
      s.dispose();
    });

    it("reads the count and the versions once the note is a Codex", async () => {
      const s = setup("notes");
      s.setKind("codex");
      await settled(s);

      expect(callsOf("note_version_status")).toStrictEqual([{ filename: FILE }]);
      expect(callsOf("list_note_versions")).toStrictEqual([{ filename: FILE }]);
      expect(s.history.rows().map((row) => [row.version.id, row.number])).toStrictEqual([
        ["v1", 1],
      ]);
      s.dispose();
    });
  });

  describe("比較モードの出入り", () => {
    // Another device may have committed since the list was read: enter rereads and takes its head
    it("enters on the head of the reread list, not the one already held", async () => {
      const s = setup();
      await settled(s);
      disk.versions = [version("v2", 120), version("v1", 100)];

      await s.history.enter();

      expect(callsOf("list_note_versions")).toHaveLength(2);
      expect(callsOf("note_version_status")).toHaveLength(2);
      expect(s.history.open()).toBe(true);
      expect(s.history.selectedVersionId()).toBe("v2");
      expect(s.history.selectedRow()?.number).toBe(2);
      s.dispose();
    });

    it("enters with nothing chosen when there is no version", async () => {
      disk.versions = [];
      disk.status = { count: 0, dirty: false, bytes_delta: 0 };
      const s = setup();
      await settled(s);

      await s.history.enter();

      expect(s.history.open()).toBe(true);
      expect(s.history.selectedVersionId()).toBeNull();
      expect(s.history.compareLine()).toStrictEqual([]);
      s.dispose();
    });

    it("drops the chosen version as it leaves", async () => {
      const s = setup();
      await settled(s);
      await s.history.enter();

      s.history.leave();

      expect(s.history.open()).toBe(false);
      expect(s.history.selectedVersionId()).toBeNull();
      s.dispose();
    });
  });

  describe("差分の印", () => {
    const DIFF = "--- v1\n+++ draft\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

    it("reads no diff and has no marks while the history is closed", async () => {
      disk.diff = DIFF;
      const s = setup();
      await settled(s);
      s.history.setSelectedVersionId("v1");
      await pause(50);

      expect(callsOf("diff_note_versions")).toStrictEqual([]);
      expect(s.history.marked()).toBeUndefined();
      expect(s.history.compareDetail()).toBe("");
      s.dispose();
    });

    it("marks the body while open and the version differs from it", async () => {
      disk.diff = DIFF;
      const s = setup();
      await settled(s);
      await s.history.enter();

      await vi.waitFor(() => expect(s.history.marked()).toBeDefined());
      expect(callsOf("diff_note_versions")).toStrictEqual([{ filename: FILE, from: "v1" }]);
      expect(s.history.marked()).toStrictEqual({
        source: "a\nb\nB\nc",
        marks: [undefined, "del", "add", undefined],
      });
      expect(s.history.compareDetail()).toBe("1 行追加 · 1 行削除");
      expect(s.history.compareLine()).toStrictEqual([
        "版 1 と比較中",
        "1 行追加 · 1 行削除",
        "読み取り専用",
      ]);
      s.dispose();
    });

    // An empty diff is "same content": no marks, and the body is drawn as it is
    it("has no marks and reads as the same when the diff is empty", async () => {
      disk.diff = "";
      const s = setup();
      await settled(s);
      await s.history.enter();

      await vi.waitFor(() => expect(s.history.compareDetail()).toBe("同じ内容"));
      expect(s.history.marked()).toBeUndefined();
      s.dispose();
    });
  });

  describe("刻めるかどうか", () => {
    it("offers a commit when the draft has moved on from the newest version", async () => {
      const s = setup();
      await settled(s);

      expect(s.history.canCommit()).toBe(true);
      s.dispose();
    });

    it("offers a commit when there is no version yet, moved or not", async () => {
      disk.versions = [];
      disk.status = { count: 0, dirty: false, bytes_delta: 0 };
      const s = setup();
      await settled(s);

      expect(s.history.canCommit()).toBe(true);
      s.dispose();
    });

    it("offers nothing when the draft equals the newest version", async () => {
      disk.status = { count: 1, dirty: false, bytes_delta: 0 };
      const s = setup();
      await settled(s);

      expect(s.history.canCommit()).toBe(false);
      s.dispose();
    });

    it("offers nothing before the body on screen is the selected note's", async () => {
      const s = setup();
      await settled(s);
      s.setLoaded(false);

      expect(s.history.canCommit()).toBe(false);
      s.dispose();
    });
  });

  describe("版を刻む", () => {
    it("summarises the first version by its size and undoes it by deleting it", async () => {
      disk.versions = [];
      disk.status = { count: 0, dirty: false, bytes_delta: 0 };
      disk.commit = version("v1", 820);
      const s = setup();
      await settled(s);

      await s.history.commit({ filename: FILE });

      expect(callsOf("commit_note_version")).toStrictEqual([{ filename: FILE, message: null }]);
      expect(s.toasts).toHaveLength(1);
      expect(s.toasts[0]?.text).toBe("版 1 を刻みました");
      expect(s.toasts[0]?.detail).toBe("820 B");
      // The count, the spine and the list mark are reread together
      expect(callsOf("note_version_status")).toHaveLength(2);
      expect(callsOf("list_note_versions")).toHaveLength(2);
      expect(s.listRefreshes()).toBe(1);

      s.toasts[0]?.undo?.();

      await vi.waitFor(() =>
        expect(callsOf("delete_note_version")).toStrictEqual([{ filename: FILE, id: "v1" }]),
      );
      await vi.waitFor(() => expect(s.listRefreshes()).toBe(2));
      expect(callsOf("list_note_versions")).toHaveLength(3);
      s.dispose();
    });

    it("summarises a later version by its delta and the days since the newest", async () => {
      disk.versions = [
        version("v1", 100, new Date(Date.now() - 3 * DAY_MS - 60_000).toISOString()),
      ];
      disk.commit = version("v2", 120);
      const s = setup();
      await settled(s);

      await s.history.commit({ filename: FILE });

      expect(s.toasts[0]?.text).toBe("版 2 を刻みました");
      expect(s.toasts[0]?.detail).toBe("版 1 から +20 B · 3 日ぶり");
      expect(s.toasts[0]?.undo).toBeTypeOf("function");
      s.dispose();
    });

    it("leaves the days out when the newest version is from today", async () => {
      disk.versions = [version("v1", 100)];
      disk.commit = version("v2", 60);
      const s = setup();
      await settled(s);

      await s.history.commit({ filename: FILE });

      expect(s.toasts[0]?.detail).toBe("版 1 から −40 B");
      s.dispose();
    });

    it("pops only the version just committed, and only for a moment", async () => {
      const s = setup();
      await settled(s);

      await s.history.commit({ filename: FILE });

      expect(s.history.freshId()).toBe("v2");
      await vi.waitFor(() => expect(s.history.freshId()).toBeNull());
      s.dispose();
    });

    // The same body in the same second makes core hand back the version that already existed.
    // Undoing it would delete that older version
    it("offers no undo and pops nothing when the version already existed", async () => {
      disk.commit = version("v1", 100);
      const s = setup();
      await settled(s);

      await s.history.commit({ filename: FILE });

      expect(s.toasts[0]?.text).toBe("版 1 を刻みました");
      expect(s.toasts[0]?.undo).toBeUndefined();
      expect(s.history.freshId()).toBeNull();
      s.dispose();
    });

    it("tells a refused commit with a toast and rereads nothing", async () => {
      disk.refuseCommit = true;
      disk.commit = { kind: "other", message: "disk full" };
      const s = setup();
      await settled(s);

      await s.history.commit({ filename: FILE });

      expect(s.toasts).toStrictEqual([
        { text: "刻めませんでした", undo: undefined, detail: undefined },
      ]);
      expect(callsOf("list_note_versions")).toHaveLength(1);
      expect(s.listRefreshes()).toBe(0);
      expect(s.history.freshId()).toBeNull();
      s.dispose();
    });
  });

  describe("選んでいた版が消えたとき", () => {
    // An undo can remove the exact version the history had chosen
    it("chooses the newest version again when the chosen one is gone", async () => {
      disk.versions = [version("v2", 120), version("v1", 100)];
      const s = setup();
      await settled(s);
      await s.history.enter();
      s.history.setSelectedVersionId("v1");
      expect(s.history.selectedVersionId()).toBe("v1");

      disk.versions = [version("v2", 120)];
      s.history.refresh();

      await vi.waitFor(() => expect(s.history.selectedVersionId()).toBe("v2"));
      s.dispose();
    });

    it("chooses the newest version that arrives when it opened before the list did", async () => {
      const s = setup();
      s.history.setOpen(true);

      await vi.waitFor(() => expect(s.history.selectedVersionId()).toBe("v1"));
      s.dispose();
    });

    it("leaves the choice alone while the history is closed", async () => {
      disk.versions = [version("v2", 120), version("v1", 100)];
      const s = setup();
      await settled(s);
      s.history.setSelectedVersionId("gone");

      await pause(50);

      expect(s.history.selectedVersionId()).toBe("gone");
      s.dispose();
    });
  });
});
