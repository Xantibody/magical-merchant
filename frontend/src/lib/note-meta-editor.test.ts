import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { createRoot, createSignal } from "solid-js";
import type { NoteMeta } from "./commands";
import { t } from "./i18n";
import { createNoteMetaEditor } from "./note-meta-editor";
import type { NoteMetaEditor } from "./note-meta-editor";

const A = "20260901_090000.md";
const B = "20260902_090000.md";

/** The shape of the `CommandError` Tauri returns. */
const commandError = (kind: string, message: string): Error =>
  Object.assign(new Error(message), { kind });

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** A promise the test settles by hand, to hold a command between its call and its answer. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let disk: Map<string, NoteMeta>;
let calls: Call[];
/** Commands that refuse, by name. */
let refuse: Set<string>;
/** Commands held until their gate opens, by name and filename. */
let held: Map<string, Gate>;

const heldKey = (cmd: string, filename: unknown): string => `${cmd}:${String(filename)}`;

function hold(cmd: string, filename: string): Gate {
  const g = gate();
  held.set(heldKey(cmd, filename), g);
  return g;
}

function answer(cmd: string, args: Record<string, unknown>): unknown {
  const filename = String(args.filename);
  if (cmd === "read_note_meta") {
    const meta = disk.get(filename);
    if (!meta) {
      throw commandError("missing", `Not found: ${filename}`);
    }
    return structuredClone(meta);
  }
  if (cmd === "update_note_meta") {
    disk.set(filename, { time: String(args.time), tags: args.tags as string[] });
  }
  return null;
}

/** A disk of two notes behind `read_note_meta` / `update_note_meta`, fresh for every test. */
function resetMetaDisk(): void {
  localStorage.clear();
  disk = new Map([
    [A, { time: "2026-09-01T09:00:00", tags: ["alpha", "beta", "gamma"] }],
    [B, { time: "2026-09-02T09:00:00", tags: ["other"] }],
  ]);
  calls = [];
  refuse = new Set();
  held = new Map();
  mockIPC(async (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    const g = held.get(heldKey(cmd, args.filename));
    if (g) {
      await g.promise;
    }
    if (refuse.has(cmd)) {
      throw commandError("other", `${cmd} refused`);
    }
    return answer(cmd, args);
  });
}

interface Setup {
  editor: NoteMetaEditor;
  setActive: (value: boolean) => void;
  select: (filename: string | undefined) => void;
  toasts: string[];
  refreshes: () => number;
  dispose: () => void;
}

function setup(options: { active?: boolean; selected?: string } = {}): Setup {
  const [active, setActive] = createSignal(options.active ?? true);
  const [selected, setSelected] = createSignal<string | undefined>(
    "selected" in options ? options.selected : A,
  );
  const toasts: string[] = [];
  let refreshes = 0;
  let editor!: NoteMetaEditor;
  const dispose = createRoot((d) => {
    editor = createNoteMetaEditor({
      active,
      selected: () => {
        const filename = selected();
        return filename === undefined ? undefined : { filename };
      },
      refreshList: () => {
        refreshes += 1;
      },
      showToast: (text) => {
        toasts.push(text);
      },
    });
    return d;
  });
  return {
    editor,
    setActive,
    select: setSelected,
    toasts,
    refreshes: () => refreshes,
    dispose,
  };
}

const reads = (): unknown[] =>
  calls.filter((c) => c.cmd === "read_note_meta").map((c) => c.args.filename);
const writes = (): Record<string, unknown>[] =>
  calls.filter((c) => c.cmd === "update_note_meta").map((c) => c.args);

/** The tags on screen, the way the tag editor builds its next list from them. */
const shownTags = (editor: NoteMetaEditor): string[] => editor.meta()?.tags ?? [];

/** Lets every pending microtask and IPC answer run. */
function settle(): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createNoteMetaEditor › 読み込み", () => {
  beforeEach(resetMetaDisk);
  afterEach(clearMocks);

  it("reads nothing while the panel is not active", async () => {
    const s = setup({ active: false });
    await settle();

    expect(reads()).toStrictEqual([]);
    expect(s.editor.meta()).toBeUndefined();

    s.select(B);
    await settle();

    expect(reads()).toStrictEqual([]);
    s.dispose();
  });

  it("reads the selected note once the panel turns active", async () => {
    const s = setup({ active: false });
    s.setActive(true);

    await vi.waitFor(() => {
      expect(s.editor.meta()).toStrictEqual(disk.get(A));
    });
    expect(reads()).toStrictEqual([A]);
    s.dispose();
  });

  it("reads again each time the panel comes back, so another device's edit is seen", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()?.tags).toStrictEqual(["alpha", "beta", "gamma"]);
    });

    s.setActive(false);
    disk.set(A, { time: "2026-09-01T09:00:00", tags: ["remote"] });
    s.setActive(true);

    await vi.waitFor(() => {
      expect(s.editor.meta()?.tags).toStrictEqual(["remote"]);
    });
    expect(reads()).toStrictEqual([A, A]);
    s.dispose();
  });

  it("reads nothing when no note is selected", async () => {
    const s = setup({ selected: undefined });
    await settle();

    expect(reads()).toStrictEqual([]);
    expect(s.editor.meta()).toBeUndefined();
    s.dispose();
  });

  it("does not show the previous note's frontmatter while the next one is on the way", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toStrictEqual(disk.get(A));
    });

    const readB = hold("read_note_meta", B);
    s.select(B);
    await settle();

    expect(reads()).toStrictEqual([A, B]);
    expect(s.editor.meta()).toBeUndefined();

    readB.open();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toStrictEqual(disk.get(B));
    });
    s.dispose();
  });

  it("reports a failed read and shows no frontmatter", async () => {
    refuse.add("read_note_meta");
    const s = setup();

    await vi.waitFor(() => {
      expect(s.editor.failed()).toBe(true);
    });
    expect(s.editor.meta()).toBeUndefined();
    s.dispose();
  });
});

describe("createNoteMetaEditor › 保存", () => {
  beforeEach(resetMetaDisk);
  afterEach(clearMocks);

  it("does nothing before the frontmatter has been read", async () => {
    const s = setup({ active: false });

    await s.editor.save({ filename: A }, { tags: ["x"] });

    expect(writes()).toStrictEqual([]);
    expect(s.refreshes()).toBe(0);
    s.dispose();
  });

  it("moves the value on screen before the write lands, then rereads the list", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });

    const write = hold("update_note_meta", A);
    const saving = s.editor.save({ filename: A }, { tags: ["alpha", "beta", "gamma", "delta"] });
    await settle();

    expect(s.editor.meta()?.tags).toStrictEqual(["alpha", "beta", "gamma", "delta"]);
    expect(writes()).toStrictEqual([
      { filename: A, time: "2026-09-01T09:00:00", tags: ["alpha", "beta", "gamma", "delta"] },
    ]);
    expect(s.refreshes()).toBe(0);

    write.open();
    await saving;

    expect(s.refreshes()).toBe(1);
    expect(s.toasts).toStrictEqual([]);
    s.dispose();
  });

  it("adds a second tag to the list that already has the first one in flight", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });

    const write = hold("update_note_meta", A);
    const first = s.editor.save({ filename: A }, { tags: [...shownTags(s.editor), "one"] });
    const second = s.editor.save({ filename: A }, { tags: [...shownTags(s.editor), "two"] });
    write.open();
    await Promise.all([first, second]);

    expect(writes().at(-1)?.tags).toStrictEqual(["alpha", "beta", "gamma", "one", "two"]);
    s.dispose();
  });

  it("keeps the tags when only the created time changes", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });

    await s.editor.save({ filename: A }, { time: "2025-01-01T00:00:00" });

    expect(writes()).toStrictEqual([
      { filename: A, time: "2025-01-01T00:00:00", tags: ["alpha", "beta", "gamma"] },
    ]);
    expect(s.editor.meta()?.time).toBe("2025-01-01T00:00:00");
    s.dispose();
  });

  it("shows a toast and reads the note again when the write is refused", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });
    refuse.add("update_note_meta");

    await s.editor.save({ filename: A }, { tags: ["lost"] });

    expect(s.toasts).toStrictEqual([t().meta.saveFailed]);
    expect(s.refreshes()).toBe(0);
    await vi.waitFor(() => {
      expect(s.editor.meta()?.tags).toStrictEqual(["alpha", "beta", "gamma"]);
    });
    expect(reads()).toStrictEqual([A, A]);
    s.dispose();
  });
});

describe("createNoteMetaEditor › タグを戻す", () => {
  beforeEach(resetMetaDisk);
  afterEach(clearMocks);

  it("puts the tag back where it stood and moves the value on screen", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });
    // The tag is gone from the screen and the disk alike, as a removal leaves it
    await s.editor.save({ filename: A }, { tags: ["alpha", "gamma"] });
    expect(s.editor.meta()?.tags).toStrictEqual(["alpha", "gamma"]);
    const before = s.refreshes();

    await s.editor.restoreTag(A, "beta", 1);

    expect(writes().at(-1)).toStrictEqual({
      filename: A,
      time: "2026-09-01T09:00:00",
      tags: ["alpha", "beta", "gamma"],
    });
    expect(s.editor.meta()?.tags).toStrictEqual(["alpha", "beta", "gamma"]);
    expect(s.refreshes()).toBe(before + 1);
    s.dispose();
  });

  it("reads the note afresh instead of trusting the value on screen", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });
    // Another device removed "gamma" since the panel read the note
    disk.set(A, { time: "2026-09-01T09:00:00", tags: ["alpha"] });

    await s.editor.restoreTag(A, "beta", 1);

    expect(reads()).toStrictEqual([A, A]);
    expect(writes().at(-1)?.tags).toStrictEqual(["alpha", "beta"]);
    s.dispose();
  });

  it("writes the tag back but leaves the value on screen alone once the selection has moved", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });
    s.select(B);
    await vi.waitFor(() => {
      expect(s.editor.meta()).toStrictEqual(disk.get(B));
    });
    disk.set(A, { time: "2026-09-01T09:00:00", tags: ["alpha", "gamma"] });

    await s.editor.restoreTag(A, "beta", 1);

    expect(writes()).toStrictEqual([
      { filename: A, time: "2026-09-01T09:00:00", tags: ["alpha", "beta", "gamma"] },
    ]);
    expect(s.editor.meta()).toStrictEqual({ time: "2026-09-02T09:00:00", tags: ["other"] });
    expect(s.refreshes()).toBe(1);
    s.dispose();
  });

  it("shows a toast and does not reread the list when the write is refused", async () => {
    const s = setup();
    await vi.waitFor(() => {
      expect(s.editor.meta()).toBeDefined();
    });
    refuse.add("update_note_meta");

    await s.editor.restoreTag(A, "beta", 1);

    expect(s.toasts).toStrictEqual([t().meta.saveFailed]);
    expect(s.refreshes()).toBe(0);
    s.dispose();
  });
});
