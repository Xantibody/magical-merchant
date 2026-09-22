import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useNavigate } from "@solidjs/router";
import { createEffect, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Editor } from "@milkdown/kit/core";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import { shortcutLabel } from "../lib/shortcuts";
import Workspace from "./Workspace";

// The real Milkdown drags in all of ProseMirror. What matters here is only the decision of
// what gets written into which note, so it is replaced by a board that carries just the
// fact that an editor is open and an entry point for typing. `.ProseMirror` and
// contenteditable match the real thing, because the check for "is the body being written
// right now" reads where the caret is. It also comes up one beat late like the real one:
// at the moment of mount there is no ProseMirror and no `onEditorReady`, and a caret placed
// without waiting for them lands on nothing
let typeInEditor: ((markdown: string) => void) | undefined;
vi.mock(import("../components/MilkdownEditor"), () => ({
  default: (props: {
    defaultValue?: string;
    onChange?: (markdown: string) => void;
    onEditorReady?: (editor?: Editor) => void;
    noteLinks?: () => { id: string }[];
  }): JSX.Element => {
    typeInEditor = props.onChange;
    const el = document.createElement("div");
    el.dataset.testid = "editor-body";
    el.textContent = props.defaultValue ?? "";
    // The real editor looks `[[` completions up while typing. The board just lists the IDs
    el.dataset.noteLinks = (props.noteLinks?.() ?? []).map((t) => t.id).join(",");
    const ready = setTimeout(() => {
      el.className = "ProseMirror";
      el.contentEditable = "true";
      props.onEditorReady?.({} as Editor);
    }, 0);
    // It is rebuilt when the body is swapped. Reporting "gone" on teardown matches the real one
    onCleanup(() => {
      clearTimeout(ready);
      props.onEditorReady?.();
    });
    return el;
  },
}));

// The row of tools that appears once the editor is up. Nothing here matters for these tests
vi.mock(import("../components/MarkdownToolbar"), () => ({
  default: (): JSX.Element => null,
}));

// markmap drags in d3. All that matters here is whether it is alongside and when it redraws
vi.mock(import("../components/MindmapView"), () => ({
  default: (props: { source: string }): JSX.Element => {
    const el = document.createElement("div");
    el.dataset.testid = "mindmap";
    createEffect(() => {
      el.textContent = props.source;
    });
    return el;
  },
}));

/** The autosave debounce. Kept in step with `Workspace.tsx`. */
const SAVE_DEBOUNCE_MS = 1000;

const FILE_A = "20260903_120000.md";
const FILE_B = "20260903_130000.md";
const TITLE_A = "会議メモ";
const TEXT_A = "ここまで書いた";
const BODY_A = `# ${TITLE_A}\n\n${TEXT_A}`;
/** A version written by another device. Treated as having come down through sync. */
const BODY_A_SYNCED = "# 会議メモ (同期後)\n\n他の端末で足された行";
const TITLE_B = "買い物";
const BODY_B = `# ${TITLE_B}\n\n牛乳`;

/** What is on disk: filename to full text. Stands in for a change made from outside mid-test. */
let disk: Map<string, string>;
/** The part of the frontmatter the list and detail read. A note without it keeps the defaults. */
let meta: Map<string, { tags?: string[]; view?: string }>;
/** Which directory it lives in. A note with no entry is a Note. */
let kinds: Map<string, "note" | "codex">;
/** Codex versions, newest first. Each carries its body, and the diff is made from these. */
let versions: Map<string, { id: string; message: string | null; body: string }[]>;
/** The commands called and their arguments. This is how we see what was written to which note. */
let calls: { cmd: string; args: Record<string, unknown> }[];
/** A gate that holds `read_note`. Reproduces acting before the answer arrives. */
let readGate: Promise<void> | undefined;
let openGate: (() => void) | undefined;
/** What happens while `update_draft` is in flight. Reproduces typing mid round trip. */
let duringSave: (() => void) | undefined;
/** A gate that holds `update_draft`. Reproduces a device whose writes are slow. */
let writeGate: Promise<void> | undefined;
let openWriteGate: (() => void) | undefined;
/** A note whose leading frontmatter cannot be read. core refuses to write to it. */
let brokenMeta: Set<string>;
/**
 * A note whose contents do not read as text, that is invalid UTF-8. It is a byte sequence
 * left behind by sync or an outside tool, and core refuses at the read step: both the
 * write and the reread that follows.
 */
let notText: Set<string>;
/** Makes `read_note` fail. Reproduces a device whose disk is temporarily unreadable. */
let readFails: boolean;

/** The body's revision. The test checks "write with the revision you read" the way core does. */
const revisionOf = (body: string): string => `rev:${body}`;

const countOf = (command: string): number => calls.filter((c) => c.cmd === command).length;

/** Picks out only the writes to that note. Used to see that none landed on the next note. */
const writesTo = (filename: string): Record<string, unknown>[] =>
  calls.filter((c) => c.cmd === "update_draft" && c.args.filename === filename).map((c) => c.args);

/** One row of the list. The time is derived from the filename, which is the ID. */
const summaryOf = (filename: string): Record<string, unknown> => ({
  kind: kinds.get(filename) ?? "note",
  path: `/data/${kinds.get(filename) ?? "notes"}/${filename}`,
  filename,
  time:
    `${filename.slice(0, 4)}-${filename.slice(4, 6)}-${filename.slice(6, 8)}` +
    `T${filename.slice(9, 11)}:${filename.slice(11, 13)}:${filename.slice(13, 15)}+09:00`,
  tags: meta.get(filename)?.tags ?? [],
  preview: disk.get(filename) ?? "",
  // core drops a key that was not written. This matches the shape where the list reader
  // sees undefined
  ...(meta.get(filename)?.view ? { view: meta.get(filename)?.view } : {}),
  // Only a Codex row carries the version count and whether it has moved on
  ...(kinds.get(filename) === "codex"
    ? {
        version_count: (versions.get(filename) ?? []).length,
        dirty: (versions.get(filename)?.[0]?.body ?? disk.get(filename)) !== disk.get(filename),
      }
    : {}),
});

const WRITE_COMMANDS = ["update_draft", "create_draft", "set_note_view", "delete_note"];

/** The shape of the `SaveError` Tauri returns. The frontend reads only `kind`. */
const saveError = (kind: string, message: string): Error =>
  Object.assign(new Error(message), { kind });

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_notes: () => [...disk.keys()].map((filename) => summaryOf(filename)),
  list_templates: () => [],
  find_backlinks: () => [],
  read_note: async ({ filename }) => {
    await readGate;
    // A file that does not read as text is refused at the read step. Reopening loads no body
    if (readFails || notText.has(String(filename))) {
      throw new Error(`could not read: ${String(filename)}`);
    }
    const body = disk.get(String(filename));
    if (body === undefined) {
      throw new Error(`note not found: ${String(filename)}`);
    }
    return { body, revision: revisionOf(body) };
  },
  read_note_meta: ({ filename }) => ({
    time: summaryOf(String(filename)).time,
    tags: meta.get(String(filename))?.tags ?? [],
    ...(meta.get(String(filename))?.view ? { view: meta.get(String(filename))?.view } : {}),
  }),
  create_draft: () => {
    disk.set(FILE_B, "");
    return `/data/notes/${FILE_B}`;
  },
  update_draft: async ({ filename, body, revision }) => {
    duringSave?.();
    await writeGate;
    const name = String(filename);
    const current = disk.get(name);
    // core does not recreate a note. A save to a note that is gone is refused at the lookup
    if (current === undefined) {
      throw saveError("missing", `Not found: ${name}`);
    }
    // core does not write to a file whose contents cannot be read. A reread does not fix it
    if (notText.has(name)) {
      throw saveError("notText", `Not text: ${name} is not valid UTF-8`);
    }
    // core refuses rather than inventing frontmatter and writing. A reread does not fix it
    if (brokenMeta.has(name)) {
      throw saveError("broken", `Parse error: ${name}`);
    }
    // The same check core makes. If someone rewrote it after the read, nothing goes over it
    if (typeof revision === "string" && revision !== revisionOf(current)) {
      throw saveError("stale", `Stale: ${name} changed since it was read`);
    }
    disk.set(name, String(body));
    return revisionOf(String(body));
  },
  delete_note: ({ filename }) => {
    disk.delete(String(filename));
  },
  promote_note_to_codex: ({ filename }) => {
    kinds.set(String(filename), "codex");
  },
  commit_note_version: ({ filename, message }) => {
    const name = String(filename);
    const body = disk.get(name) ?? "";
    const version = {
      id: `v${countOf("commit_note_version")}`,
      message: (message as string | null) ?? null,
      body,
    };
    versions.set(name, [version, ...(versions.get(name) ?? [])]);
    return {
      id: version.id,
      time: "2026-09-17T14:03:00+09:00",
      message: version.message,
      bytes: body.length,
    };
  },
  list_note_versions: ({ filename }) =>
    (versions.get(String(filename)) ?? []).map((v) => ({
      id: v.id,
      time: "2026-09-17T14:03:00+09:00",
      message: v.message,
      bytes: v.body.length,
    })),
  // Only the shape of core's unified diff is imitated. No lines are matched up
  diff_note_versions: ({ filename, from }) => {
    const name = String(filename);
    const version = versions.get(name)?.find((v) => v.id === from);
    const draft = disk.get(name) ?? "";
    if (!version || version.body === draft) {
      return "";
    }
    return [
      `--- ${String(from)}`,
      "+++ draft",
      "@@ -1 +1 @@",
      ...version.body.split("\n").map((line) => `-${line}`),
      ...draft.split("\n").map((line) => `+${line}`),
      "",
    ].join("\n");
  },
  restore_note_version: ({ filename, id, revision }) => {
    const name = String(filename);
    const current = disk.get(name) ?? "";
    if (typeof revision === "string" && revision !== revisionOf(current)) {
      throw saveError("stale", `Stale: ${name} changed since it was read`);
    }
    const version = versions.get(name)?.find((v) => v.id === id);
    if (!version) {
      throw saveError("other", `version not found: ${String(id)}`);
    }
    versions.set(name, [
      { id: "before", message: "before restore", body: current },
      ...(versions.get(name) ?? []),
    ]);
    disk.set(name, version.body);
    return revisionOf(version.body);
  },
  note_version_status: ({ filename }) => {
    const own = versions.get(String(filename)) ?? [];
    const draft = disk.get(String(filename)) ?? "";
    return {
      count: own.length,
      dirty: own.length > 0 && own[0]?.body !== draft,
      bytes_delta: own[0] ? draft.length - own[0].body.length : 0,
    };
  },
  delete_note_version: ({ filename, id }) => {
    const name = String(filename);
    versions.set(
      name,
      (versions.get(name) ?? []).filter((v) => v.id !== id),
    );
  },
  set_note_view: ({ filename, view }) => {
    const name = String(filename);
    const entry = { ...meta.get(name) };
    if (typeof view === "string") {
      entry.view = view;
    } else {
      delete entry.view;
    }
    meta.set(name, entry);
    return null;
  },
};

let shell: Shell | undefined;
let navigateTo: ((to: string) => void) | undefined;

function CaptureShell(): JSX.Element {
  shell = useShell();
  return null;
}

/** Borrows `navigate` from inside the router so the widget's `?file=` can be fed in. */
function WorkspaceRoute(): JSX.Element {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return <Workspace />;
}

/** The Codex surface of the same view. What sits at `/codex` has the same shape as in `App.tsx`. */
function CodexRoute(): JSX.Element {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return <Workspace kind="codex" />;
}

/** Renders the list alone. Nothing is opened, so what is visible is the rows themselves. */
function renderWorkspace(): void {
  render(() => (
    <ShellProvider>
      <CaptureShell />
      <MemoryRouter>
        <Route path="/" component={WorkspaceRoute} />
        <Route path="/codex" component={CodexRoute} />
      </MemoryRouter>
    </ShellProvider>
  ));
}

const rowOf = (title: string): Promise<HTMLElement> =>
  screen.findByRole("button", { name: new RegExp(title, "u") });

/** The body editor. It does not become contenteditable until it has fully come up. */
function editorBody(): HTMLElement {
  return screen.getByTestId("editor-body");
}

/** Gets as far as note A being open. On a narrow screen the body appears only once it is open. */
async function openNoteA(): Promise<void> {
  renderWorkspace();
  fireEvent.click(await rowOf(TITLE_A));
  // Until the body arrives and its editor has fully come up. The editor stands up after the
  // body arrives, so wait for the text to be on screen and contenteditable to be set
  await waitFor(() => {
    expect(screen.getByText(TEXT_A)).toBeDefined();
    expect(editorBody().isContentEditable).toBe(true);
  });
}

function titleInput(): HTMLInputElement {
  return screen.getByPlaceholderText<HTMLInputElement>("タイトル");
}

/** The version count shown on the Codex meta line. */
const metaLine = (): HTMLElement | null => document.querySelector(".detail-version-status");

/**
 * A version row in the history. Its first line is `版 N` plus a timestamp, so a digit of the
 * date follows the number. That is the marker that keeps it apart from the `版 N に戻す`
 * button shown under the selected row.
 */
const versionRow = (n: number): Promise<HTMLElement> =>
  screen.findByRole("button", { name: new RegExp(`^版 ${n} \\d`, "u") });

/**
 * The folded-corner page on a list row. A reread list rebuilds its rows, so this reads the
 * mark on the row that carries that title now, not on the row that was held before.
 */
const markOf = (title: string): HTMLElement | null =>
  screen
    .getByRole("button", { name: new RegExp(title, "u") })
    .querySelector<HTMLElement>(".page-mark");

/** A pause for seeing something not happen. `waitFor` waits until it does, so it is no use. */
function sleep(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Puts the caret in the body. The editor is there from the moment the note opens, so this is
 * not "start writing" but only "put the writer's hand there".
 */
async function startEditingBody(): Promise<void> {
  fireEvent.keyDown(titleInput(), { key: "Enter" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("editor-body")));
}

/**
 * Presses. Opening and closing a menu and selecting a row are decided by pointerdown and
 * pointerup, which is how the component library works, so a click alone does nothing.
 */
function press(target: HTMLElement): void {
  fireEvent.pointerDown(target, { button: 0 });
  fireEvent.pointerUp(target, { button: 0 });
}

/** Opens the `...` menu. Returns the menu that opened. */
function openNoteMenu(): Promise<HTMLElement> {
  press(screen.getByRole("button", { name: "この Note の操作" }));
  return screen.findByRole("menu");
}

/** Opens the `...` menu, then presses one row inside it. */
async function runNoteAction(name: string): Promise<void> {
  // The history spine answers to the same name. What is pressed is the row in the menu
  const menu = await openNoteMenu();
  press(await within(menu).findByRole("menuitem", { name: new RegExp(name, "u") }));
}

/** The curtain darkening behind the sheet. It has no role and no name, so class finds it. */
function templateBackdrop(): Element {
  const found = document.querySelector(".template-picker-backdrop");
  if (!found) {
    throw new Error("expected the sheet to have a backdrop");
  }
  return found;
}

/** `新規`, then `空の Note`. Going through the template sheet is the same order as the real thing. */
async function createEmptyNote(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /新規/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /空の Note/u }));
}

const blockReads = (): void => {
  const gate = Promise.withResolvers<void>();
  readGate = gate.promise;
  openGate = gate.resolve;
};

const releaseReads = (): void => {
  openGate?.();
  readGate = undefined;
  openGate = undefined;
};

const blockWrites = (): void => {
  const gate = Promise.withResolvers<void>();
  writeGate = gate.promise;
  openWriteGate = gate.resolve;
};

const releaseWrites = (): void => {
  openWriteGate?.();
  writeGate = undefined;
  openWriteGate = undefined;
};

/** Resets the disk, the IPC and the viewport width to the starting state for one test. */
async function setupWorkspace(): Promise<void> {
  // The width where the list and the detail sit side by side. Only in this shape can the
  // new-note button be pressed mid-edit; at phone width the whole list pane is hidden
  await page.viewport(1280, 800);
  disk = new Map([[FILE_A, BODY_A]]);
  meta = new Map();
  kinds = new Map();
  versions = new Map();
  brokenMeta = new Set();
  notText = new Set();
  readFails = false;
  calls = [];
  shell = undefined;
  navigateTo = undefined;
  typeInEditor = undefined;
  duringSave = undefined;
  releaseReads();
  releaseWrites();
  localStorage.clear();
  mockWindows("main");
  mockIPC((cmd, args) => {
    const payload = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: payload });
    const handler = HANDLERS[cmd];
    if (!handler) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return handler(payload);
  });
}

function teardownWorkspace(): void {
  // Release the held reads and writes before tearing down. Leave no promise still waiting
  releaseReads();
  releaseWrites();
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

describe("Workspace › 一覧の行", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // The tags are written in the body too. Listing them on the row as well doubles the text
  // read before choosing, and the longer the title the sooner it is cut off
  it("keeps a row down to its title and one stamp", async () => {
    meta.set(FILE_A, { tags: ["sf6", "vega"] });
    renderWorkspace();

    const row = await rowOf(TITLE_A);

    expect(row.textContent).not.toContain("sf6");
    // Only one thing is left at the right edge: the time if today, otherwise the date
    expect(row.textContent).toMatch(new RegExp(`^${TITLE_A}(\\d\\d:\\d\\d|\\d\\d/\\d\\d)$`, "u"));
  });

  // If a note being unwritable only shows once it is open, you find out after trying to write
  it("marks a read-only note with a lock", async () => {
    meta.set(FILE_A, { view: "preview" });
    renderWorkspace();

    await expect(screen.findByTitle("読み取り専用")).resolves.toBeDefined();
  });

  it("leaves a writable note unmarked", async () => {
    renderWorkspace();
    await rowOf(TITLE_A);

    expect(screen.queryByTitle("読み取り専用")).toBeNull();
  });

  /**
   * The badge that floats at the shoulder while `Cmd` is held down. Both buttons at the head
   * of the list have a key, so a badge on only one of them reads as the other having no key.
   */
  it("wears its key on the shoulder of both buttons at the head of the list", async () => {
    renderWorkspace();
    await rowOf(TITLE_A);

    // The spelling depends on the platform: `Cmd` on macOS, `Ctrl+` elsewhere. Read it from
    // the table; do not copy it out
    expect(screen.getByRole("button", { name: /新規/u }).dataset.hintKey).toBe(
      shortcutLabel("newNote"),
    );
    expect(document.querySelector<HTMLElement>(".list-pin")?.dataset.hintKey).toBe(
      shortcutLabel("listPin"),
    );
  });
});

describe("Workspace › 触る端末からのテンプレート", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // On a touch device the only way to the template sheet is a long press on the new-note
  // button. A finger keeps jittering a few px while it presses, and if that jitter cancels
  // the long press the sheet is never reached and lifting the finger makes an empty note
  // (#253)
  it("opens the template sheet on a long press the finger jitters through", async () => {
    renderWorkspace();
    const newNote = await screen.findByRole("button", { name: /新規/u });

    fireEvent.pointerDown(newNote, { pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(newNote, { pointerType: "touch", clientX: 103, clientY: 102 });
    fireEvent.pointerMove(newNote, { pointerType: "touch", clientX: 99, clientY: 104 });

    // The 500ms of the long press is waited out in real time
    await screen.findByRole("menuitem", { name: /空の Note/u }, { timeout: 2000 });

    // The click from lifting the finger after the sheet appears is swallowed. If an empty
    // Note were added on top of the sheet opening, the long press would be unusable
    fireEvent.pointerUp(newNote, { pointerType: "touch", clientX: 99, clientY: 104 });
    fireEvent.click(newNote);
    expect(countOf("create_draft")).toBe(0);
  });

  // The sheet has no cancel button, and the curtain covers the button that opened it. The
  // curtain sits inside the container, so the component reads a press on it as an inside
  // press; unless the curtain handles it itself, a finger cannot get out without choosing
  // something
  it("closes the template sheet when the finger taps the backdrop", async () => {
    renderWorkspace();
    const newNote = await screen.findByRole("button", { name: /新規/u });

    fireEvent.pointerDown(newNote, { pointerType: "touch", clientX: 100, clientY: 100 });
    await screen.findByRole("menuitem", { name: /空の Note/u }, { timeout: 2000 });
    fireEvent.pointerUp(newNote, { pointerType: "touch", clientX: 100, clientY: 100 });

    fireEvent.click(templateBackdrop());

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /空の Note/u })).toBeNull());
    // Only got out. No note was added
    expect(countOf("create_draft")).toBe(0);
  });
});

describe("Workspace › 常時編集", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // Moving between a reading mode and a writing mode puts one extra step before every write
  it("opens a note with the editor already in it", async () => {
    await openNoteA();

    expect(screen.getByTestId("editor-body").textContent).toBe(TEXT_A);
  });

  // A read-only note gives no sign anywhere that it can be written
  it("gives a read-only note no editor and no writable title", async () => {
    meta.set(FILE_A, { view: "preview" });
    renderWorkspace();
    fireEvent.click(await rowOf(TITLE_A));
    await screen.findByText(TEXT_A);

    expect(screen.queryByTestId("editor-body")).toBeNull();
    expect(titleInput().readOnly).toBe(true);
  });

  it("locks a note from the menu", async () => {
    await openNoteA();

    await runNoteAction("読み取り専用にする");

    await waitFor(() => expect(meta.get(FILE_A)?.view).toBe("preview"));
    await waitFor(() => expect(screen.queryByTestId("editor-body")).toBeNull());
  });

  // Locking switches to the reading mode at once. If what appears there is the body as it
  // was just after loading, the characters just typed look as if they vanished
  it("keeps what was just typed when the note is locked", async () => {
    await openNoteA();
    typeInEditor?.("打ちかけの本文");

    await runNoteAction("読み取り専用にする");

    await waitFor(() => expect(screen.queryByTestId("editor-body")).toBeNull());
    expect(screen.getByText("打ちかけの本文")).toBeDefined();
  });

  it("opens the menu from the keyboard", async () => {
    await openNoteA();

    fireEvent.keyDown(globalThis, { key: ".", metaKey: true });

    await waitFor(() => expect(screen.getByRole("menu")).toBeDefined());
  });

  // Closing on an outside press is the menu's own job. Handing it to a central handler
  // outside this view (`AppLayout`) leaves it open when only this surface is rendered
  it("closes the menu when a press lands outside it", async () => {
    await openNoteA();
    await openNoteMenu();
    // The outside watcher is installed on the task after the open. A human finger is slower
    await sleep(0);

    fireEvent.pointerDown(titleInput());

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes the menu on Escape", async () => {
    await openNoteA();
    await openNoteMenu();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  // There is a `Cmd .` route that opens it, so what it opens can also be walked without a finger
  it("walks the rows with the arrow keys", async () => {
    await openNoteA();
    const menu = await openNoteMenu();
    // The opened menu takes the focus first. Walking can only start from there
    await waitFor(() => expect(document.activeElement).toBe(menu));

    fireEvent.keyDown(menu, { key: "ArrowDown" });

    await waitFor(() =>
      expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]),
    );
  });

  // A promoted record is handed over ready to type into the moment it opens. At the point
  // the body arrives the editor is not up yet, so a caret placed there lands on nothing
  it("puts the caret in a promoted note once its editor is up", async () => {
    renderWorkspace();
    await rowOf(TITLE_A);

    navigateTo?.(`/?file=${FILE_A}&edit=1`);

    await waitFor(() => expect(document.activeElement).toBe(editorBody()));
    expect(editorBody().textContent).toBe(TEXT_A);
  });

  // Replacing it would make the body being written disappear while the map is looked at
  it("lays the map beside the note instead of over it", async () => {
    await openNoteA();

    await runNoteAction("マップを並べる");

    await waitFor(() => expect(screen.getByTestId("mindmap")).toBeDefined());
    expect(screen.getByTestId("editor-body")).toBeDefined();
  });

  // Rebuilding the map alongside on every keystroke keeps the branches jumping next to the
  // writing. Let it catch up once the hand stops
  it("redraws the map once the typing pauses, not on every keystroke", async () => {
    await openNoteA();
    await runNoteAction("マップを並べる");
    await screen.findByTestId("mindmap");

    typeInEditor?.("打ちかけ");
    typeInEditor?.("打ちかけの本文");

    expect(screen.getByTestId("mindmap").textContent).not.toContain("打ちかけ");
    await waitFor(() =>
      expect(screen.getByTestId("mindmap").textContent).toContain("打ちかけの本文"),
    );
  });

  // Waiting on opening the next note would leave the previous note's map up for one beat
  it("draws the next note's map right away", async () => {
    disk.set(FILE_B, BODY_B);
    meta.set(FILE_B, { view: "mindmap" });
    await openNoteA();
    await runNoteAction("マップを並べる");
    await screen.findByTestId("mindmap");

    fireEvent.click(await rowOf(TITLE_B));

    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    expect(screen.getByTestId("mindmap").textContent).toContain(TITLE_B);
  });
});

describe("Workspace › ノートに効くキー", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  it("steps to the next note on ⌘↓ from outside the text", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();

    fireEvent.keyDown(globalThis, { key: "ArrowDown", metaKey: true });

    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
  });

  // While the focus is on a list row, `Up` and `Down` move within that list. The focus moves
  // to the row they land on: without that, a second `Down` counts again from the first row
  it("steps to the next note on ↓ inside the list and moves focus with it", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    const rowA = await rowOf(TITLE_A);
    rowA.focus();

    fireEvent.keyDown(rowA, { key: "ArrowDown" });

    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    expect(document.activeElement).toBe(await rowOf(TITLE_B));
  });

  // In the body, `Down` moves the caret one line. An arrow pressed outside the list is not
  // taken away
  it("leaves a plain ↓ to the caret while the body is being written", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(screen.getByTestId("editor-body"), { key: "ArrowDown" });

    await sleep(100);
    expect(titleInput().value).toBe(TITLE_A);
  });

  // `Up` pressed at the end has nowhere to go. It does not preventDefault either, so it falls
  // through to scrolling the list
  it("does nothing on ↑ at the top of the list", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    const rowA = await rowOf(TITLE_A);
    rowA.focus();

    const consumed = !fireEvent.keyDown(rowA, { key: "ArrowUp" });

    await sleep(100);
    expect(titleInput().value).toBe(TITLE_A);
    expect(consumed).toBe(false);
  });

  // On macOS `Cmd Up` and `Cmd Down` jump to the start and the end of the document. That is
  // the browser default, so the editor does not preventDefault and the only way to tell them
  // apart is where the caret is
  it("leaves ⌘↑ and ⌘↓ to the caret while the body is being written", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(screen.getByTestId("editor-body"), { key: "ArrowDown", metaKey: true });
    fireEvent.keyDown(screen.getByTestId("editor-body"), { key: "ArrowUp", metaKey: true });

    await sleep(100);
    expect(titleInput().value).toBe(TITLE_A);
  });

  // The editor is always open, so while a note is open the caret is nearly always in the
  // body. A key that does not work in the body may as well not exist (#211)
  it("opens the note info on ⌘⇧I while the caret is in the body", async () => {
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(editorBody(), { key: "I", metaKey: true, shiftKey: true });

    await waitFor(() => expect(screen.getByText("作成日時")).toBeDefined());
  });

  it("reverts on ⌘⇧R while the caret is in the body", async () => {
    const before = `# ${TITLE_A}\n\n前の本文`;
    localStorage.setItem(`note-backup:${FILE_A}`, before);
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(editorBody(), { key: "R", metaKey: true, shiftKey: true });

    await waitFor(() => expect(disk.get(FILE_A)).toBe(before));
  });

  // `Cmd I` is Milkdown's italic. While writing, that is the right meaning, so it is not
  // picked up here
  it("leaves ⌘I to the editor's italic while the body is being written", async () => {
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(editorBody(), { key: "i", metaKey: true });

    await sleep(100);
    expect(screen.queryByText("作成日時")).toBeNull();
  });

  // `Cmd Shift R` means nothing else in a text field. Even with the hand on the title,
  // pressing it reverts
  it("reverts on ⌘⇧R while the title is being typed", async () => {
    const before = `# ${TITLE_A}\n\n前の本文`;
    localStorage.setItem(`note-backup:${FILE_A}`, before);
    await openNoteA();
    titleInput().focus();

    fireEvent.keyDown(titleInput(), { key: "R", metaKey: true, shiftKey: true });

    await waitFor(() => expect(disk.get(FILE_A)).toBe(before));
  });
});

describe("Workspace › 保存の見え方", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // A green "saved" left lit keeps glowing at the edge of vision the whole time you write.
  // After 2 seconds it settles onto the time it saved at
  it("settles from the green tick onto the time it saved at", async () => {
    await openNoteA();

    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });

    await screen.findByText("保存しました", {}, { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/に保存$/u)).toBeDefined(), { timeout: 4000 });
  });

  /**
   * On a wide screen the save state is shown by the bottom bar, which lives outside this
   * view (`AppLayout`). The hand-off goes through the shell, so this checks the landing
   * reached it.
   */
  it("hands the landing to the shell for the bar outside this view", async () => {
    await openNoteA();
    expect(shell?.saveState().status).toBe("idle");

    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });

    await waitFor(() => expect(shell?.saveState().status).toBe("saved"), { timeout: 3000 });
    await waitFor(() => expect(shell?.saveState().status).toBe("savedAt"), { timeout: 4000 });
    expect(shell?.saveState().at).toMatch(/^\d\d:\d\d$/u);
  });

  // The 2 seconds of green belong to that note. A "saved at 21:40" that lands after moving
  // to the next note claims a save on a note that was never saved
  it("does not carry the saved time onto the next note", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });
    await screen.findByText("保存しました", {}, { timeout: 3000 });

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));

    await sleep(2500);
    expect(screen.queryByText(/に保存$/u)).toBeNull();
  });

  // On a device with slow writes, the previous note's save lands after moving to the next
  // one. Showing that signal makes the note just opened claim it was saved
  it("keeps a late save's tick off the note opened after it", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    blockWrites();
    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });
    await screen.findByText("保存中…", {}, { timeout: 3000 });

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    releaseWrites();

    await waitFor(() => expect(disk.get(FILE_A)).toContain("会議メモ 改"));
    expect(screen.queryByText("保存しました")).toBeNull();
    expect(screen.queryByText("保存中…")).toBeNull();
  });
});

describe("Workspace › 外から書き換わったノートの読み直し", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // A change downloaded by sync reaches a note that is still open
  it("reloads the open note when dataVersion increases", async () => {
    await openNoteA();
    expect(titleInput().value).toBe(TITLE_A);

    disk.set(FILE_A, BODY_A_SYNCED);
    shell?.refreshData();

    await waitFor(() => expect(screen.getByText("他の端末で足された行")).toBeDefined());
    expect(titleInput().value).toBe("会議メモ (同期後)");
    expect(countOf("read_note")).toBe(2);
    // A reread only reads. Writing back here would crush the other side's version with ours
    for (const command of WRITE_COMMANDS) {
      expect(countOf(command)).toBe(0);
    }
  });

  // Swapping the body while the editor is open destroys the caret, the selection and the IME
  it("leaves the body alone while the editor is open", async () => {
    await openNoteA();
    await startEditingBody();
    const readsBefore = countOf("read_note");

    disk.set(FILE_A, BODY_A_SYNCED);
    shell?.refreshData();

    // Wait until the list reread arrives, then check that the body alone is not reread
    await screen.findByText("会議メモ (同期後)");
    expect(countOf("read_note")).toBe(readsBefore);
    expect(screen.getByTestId("editor-body").textContent).toBe(TEXT_A);
    for (const command of WRITE_COMMANDS) {
      expect(countOf(command)).toBe(0);
    }
  });

  // If it stays "waiting to save" after an autosave has fired, the synced version never
  // reaches the screen again
  it("reloads the open note after an autosave has already fired", async () => {
    await openNoteA();
    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    const readsBefore = countOf("read_note");

    disk.set(FILE_A, BODY_A_SYNCED);
    shell?.refreshData();

    await waitFor(() => expect(screen.getByText("他の端末で足された行")).toBeDefined());
    expect(countOf("read_note")).toBe(readsBefore + 1);
  });
});

describe("Workspace › 編集中に選択が差し替わる", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // The new-note button can be pressed mid-edit. If only the selection moves at that moment,
  // the next save writes the previous note's body into the new note
  it("keeps the typed body in its own note when a new note takes the selection", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\nもう一行`);

    await createEmptyNote();
    await waitFor(() => expect(titleInput().value).toBe(""));

    // Leaving the screen flushes every save that is waiting
    cleanup();
    await waitFor(() => expect(countOf("update_draft")).toBe(1));
    expect(writesTo(FILE_B)).toStrictEqual([]);
    expect(disk.get(FILE_A)).toContain("もう一行");
    expect(disk.get(FILE_B)).toBe("");
  });

  // The path where a widget row opens another note through `?file=` is the same
  it("keeps the typed body in its own note when ?file= opens another note", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\nもう一行`);

    navigateTo?.(`/?file=${FILE_B}`);
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));

    cleanup();
    await waitFor(() => expect(countOf("update_draft")).toBe(1));
    expect(writesTo(FILE_B)).toStrictEqual([]);
    expect(disk.get(FILE_A)).toContain("もう一行");
    expect(disk.get(FILE_B)).toBe(BODY_B);
  });

  // A delete selects the next note. A waiting save still lands on the note it was typed into
  it("keeps the typed body in its own note when a delete moves the selection", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\nもう一行`);

    // Leaving the title field before the next note's body arrives flushes the waiting save
    blockReads();
    await runNoteAction("削除");
    fireEvent.change(titleInput(), { target: { value: TITLE_A } });

    // What was typed lands on the note being deleted. Nothing is written to the next note
    await waitFor(() => expect(disk.get(FILE_A)).toContain("もう一行"), { timeout: 3000 });
    expect(writesTo(FILE_B)).toStrictEqual([]);

    // The real delete 5 seconds later outlives the test. Undo it the same way the UI does
    await waitFor(() => expect(shell?.toast()?.undo).toBeInstanceOf(Function));
    shell?.toast()?.undo?.();
  });

  // Until the next note's body arrives, the previous note's editor and title stay on screen.
  // Typing there would write "the previous note's body plus what was typed" into the next
  // note, and for a note opened for the first time there is no revision either, so core
  // cannot stop it
  it("does not write what is typed while the next note is still loading", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();

    blockReads();
    fireEvent.click(await rowOf(TITLE_B));
    // The selection has moved and the meta line shows B's creation time, but the body is still A's
    await waitFor(() => expect(screen.getByText("2026年9月3日 13:00")).toBeDefined());
    typeInEditor?.(`${TEXT_A}\n\n届く前に打った行`);
    fireEvent.input(titleInput(), { target: { value: "届く前に打った題" } });
    releaseReads();

    await waitFor(() => expect(editorBody().textContent).toBe("牛乳"));
    await sleep(1500);
    expect(writesTo(FILE_B)).toStrictEqual([]);
    expect(disk.get(FILE_B)).toBe(BODY_B);
    expect(titleInput().value).toBe(TITLE_B);
  });

  // When the autosave already landed, there is no waiting save left on leaving. The row's
  // title has changed all the same, so without a reread the list stays stale
  it("refreshes the list on leaving a note whose autosave already landed", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });
    await screen.findByText("保存しました", {}, { timeout: 3000 });
    expect(screen.queryByRole("button", { name: /会議メモ 改/u })).toBeNull();

    fireEvent.click(await rowOf(TITLE_B));

    await expect(rowOf("会議メモ 改")).resolves.toBeDefined();
  });

  // Tapping and starting to write while the reread triggered by regaining focus is in flight
  // leaves the pre-read body on screen. Unless the revision sent with the save matches that
  // body, the other side's version is crushed on the pretence of having read it
  it("saves with the revision it actually read when a refresh lands mid-edit", async () => {
    await openNoteA();

    blockReads();
    disk.set(FILE_A, BODY_A_SYNCED);
    shell?.refreshData();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\nこの端末で足した行`);
    releaseReads();

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    expect(writesTo(FILE_A)[0]?.revision).toBe(revisionOf(BODY_A));
    // The revision that was read gets it refused, so the other side's line survives
    expect(disk.get(FILE_A)).toBe(BODY_A_SYNCED);
  });

  // What a Stale backs up is the body on screen now, not the copy that flew off. Characters
  // typed during the round trip are not kept anywhere yet
  it("backs up the draft as it stands when the save is refused as stale", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n一回目`);
    disk.set(FILE_A, BODY_A_SYNCED);
    duringSave = () => {
      duringSave = undefined;
      typeInEditor?.(`${TEXT_A}\n\n二回目`);
    };

    await waitFor(() => expect(screen.getByText("他の端末で足された行")).toBeDefined(), {
      timeout: 3000,
    });
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("二回目");
  });

  // If a save queued before the backup and reread comes out afterwards, the old draft gets
  // through carrying the revision of the reread version
  it("drops a save that was queued before the stale reload", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n一回目`);
    disk.set(FILE_A, BODY_A_SYNCED);
    duringSave = () => {
      duringSave = undefined;
      typeInEditor?.(`${TEXT_A}\n\n二回目`);
      // Queue one more save behind the one in flight
      fireEvent.change(titleInput(), { target: { value: TITLE_A } });
    };

    await waitFor(() => expect(screen.getByText("他の端末で足された行")).toBeDefined(), {
      timeout: 3000,
    });
    // A save after the reread goes through. By the time it lands, check that the old queued
    // draft was not written; if it had been, the count would be 3
    fireEvent.input(titleInput(), { target: { value: "読み直したあとの題" } });
    await waitFor(() => expect(disk.get(FILE_A)).toContain("読み直したあとの題"), {
      timeout: 3000,
    });
    expect(countOf("update_draft")).toBe(2);
    expect(disk.get(FILE_A)).toBe("# 読み直したあとの題\n\n他の端末で足された行");
  });

  // Even when the reread fails, the body on screen is not swapped. Standing up an empty
  // editor looks like an empty note, and the next keystroke goes to write a body of a few
  // characters to disk
  it("keeps the draft on screen when a refresh read fails mid-edit", async () => {
    await openNoteA();

    blockReads();
    readFails = true;
    shell?.refreshData();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n読めなかったあとの行`);
    releaseReads();

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    // The editor was not rebuilt. A rebuild would empty the body that was being typed
    expect(screen.getByText(TEXT_A)).toBeDefined();
    // The revision also stays the one that was read. Nothing could move it, since the reread failed
    expect(writesTo(FILE_A)[0]?.revision).toBe(revisionOf(BODY_A));
    expect(disk.get(FILE_A)).toContain("読めなかったあとの行");
  });

  // Nothing is written to a note that could not be read. A save with no revision walks
  // straight past core's check, so the few characters typed become the whole file
  it("writes nothing to a note whose body could not be read", async () => {
    readFails = true;
    renderWorkspace();
    fireEvent.click(await rowOf(TITLE_A));
    await waitFor(() => expect(countOf("read_note")).toBe(1));
    // Until the read has been refused. This is where we see whether an empty editor stands up
    await sleep(50);

    // A body that could not be read is not put in the editor. Doing so looks like an empty note
    expect(screen.queryByTestId("editor-body")).toBeNull();
    typeInEditor?.("数文字");
    await sleep(SAVE_DEBOUNCE_MS + 500);

    expect(countOf("update_draft")).toBe(0);
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });

  // core refuses every write to a note whose frontmatter is broken. A reread does not fix it,
  // so without backing up what was typed, every keystroke is silently thrown away
  it("backs up the draft and says so when the note's frontmatter cannot be read", async () => {
    brokenMeta.add(FILE_A);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n壊れたノートに足した行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/保存できません/u));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("壊れたノートに足した行");
    // A refused write changes nothing
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });

  // What is backed up on a refusal is, as with Stale, the body on screen now and not the
  // copy that flew off. Characters typed during the round trip are in neither the file nor
  // the backup, and they are gone if the warning is read and the note simply closed
  it("backs up the draft as it stands when the save is refused as broken", async () => {
    brokenMeta.add(FILE_A);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n一回目`);
    duringSave = () => {
      duringSave = undefined;
      typeInEditor?.(`${TEXT_A}\n\n二回目`);
    };

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/保存できません/u), {
      timeout: 3000,
    });
    // Checked before the next debounce arrives. If this were the first round, whoever closes
    // the note loses the second
    expect(countOf("update_draft")).toBe(1);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("二回目");
  });

  // The body on screen now is not necessarily the one it was typed into. Moving A to B to A
  // during the round trip puts the selection back on A while the body on screen is still B's,
  // because A's reread has not arrived. Backing up what is on screen there would make A's
  // backup B's body, and the refused keystrokes would survive nowhere
  it("keeps the refused note's own draft when the selection went away and back", async () => {
    disk.set(FILE_B, BODY_B);
    brokenMeta.add(FILE_A);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n一回目`);

    // Stop it right where the save took off. The scheduled save is already gone, so a later
    // change of selection will not wait for the save in flight
    blockWrites();
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    // Back to A, but the body does not arrive. Only the selection is A; on screen is B's body
    blockReads();
    fireEvent.click(await rowOf(TITLE_A));
    await waitFor(() => expect(screen.getByText("牛乳")).toBeDefined());

    releaseWrites();
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/保存できません/u), {
      timeout: 3000,
    });
    const backup = localStorage.getItem(`note-backup:${FILE_A}`);
    expect(backup).toContain("一回目");
    expect(backup).not.toContain("牛乳");
    // What is on screen is not A's typing. Name the note and say where the backup is
    expect(shell?.toast()?.message).toContain(TITLE_A);
  });

  // A note deleted after it was opened. core refuses on the grounds that this is not the
  // entry point for recreating a note, so, like broken frontmatter, a reread does not fix it.
  // Without a backup, what was typed is gone the moment the note is left
  it("backs up the draft and says so when the note is already gone", async () => {
    await openNoteA();
    await startEditingBody();
    // Between the keystroke and the save taking off, another screen or device deletes it
    duringSave = () => disk.delete(FILE_A);
    typeInEditor?.(`${TEXT_A}\n\n消えたノートに足した行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/もう在りません/u));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("消えたノートに足した行");
    // A note that is gone loses its row as soon as the list is fetched again. There is no way
    // to reopen it and call the draft back with Revert either, so we do not say it can be
    // called back. Saying so would have people believe it and close the note
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(shell?.toast()?.message).toMatch(/写して/u);
  });

  // The open note was replaced by sync or an outside tool with a byte sequence that does not
  // read as text. core refuses the write at the read step, and silently dropping that as a
  // temporary failure leaves what was typed neither on disk nor in a backup, and the note can
  // be closed without any warning
  it("backs up the draft and says so when the note is no longer text", async () => {
    await openNoteA();
    await startEditingBody();
    // Between the keystroke and the save taking off, sync leaves an unreadable byte sequence
    duringSave = () => notText.add(FILE_A);
    typeInEditor?.(`${TEXT_A}\n\n読めなくなったノートに足した行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/文字として読めない/u));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain(
      "読めなくなったノートに足した行",
    );
    // Reopening cannot read the body either, so we do not say Revert can get it back
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(shell?.toast()?.message).toMatch(/写して/u);
    // A refused write changes nothing
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });

  // "Copy it out while it is still on screen" only lands when the refused note is the one on
  // screen. If the selection moved on during the round trip, what is on screen is another
  // note's body and there is nothing to copy where it points. Name the note and say where
  // the backup is
  it("names the vanished note instead of pointing at the note now on screen", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n消えたノートに足した行`);

    // Stop it right where the save took off. The scheduled save is gone, so a later change
    // of selection does not wait for the save in flight
    blockWrites();
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    // During the round trip, another screen or device deletes A
    disk.delete(FILE_A);

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    releaseWrites();

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/もう在りません/u), {
      timeout: 3000,
    });
    const message = shell?.toast()?.message;
    // Name which note this is about, so it is not read as being about the B on screen
    expect(message).toContain(TITLE_A);
    // Do not point at something that is neither on screen nor behind Revert
    expect(message).not.toMatch(/画面にあるうち|写して|戻す/u);
    // Do say the backup is on the device. Keeping it beats losing it
    expect(message).toMatch(/この端末に控え/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("消えたノートに足した行");
  });

  // Stale had the same hole. When the selection moved on during the round trip, A is never
  // reread, yet the message said "reloaded; you can call it back with Revert". What is on
  // screen is B, so it reads as B having been reread and B being reverted. Name A, and say it
  // takes reopening A first. The note is writable, so there is a way to get the draft back
  it("names the note changed elsewhere instead of pointing at the note now on screen", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n譲る前に打った行`);

    // Stop it right where the save took off. The scheduled save is gone, so a later change
    // of selection does not wait for the save in flight
    blockWrites();
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    // During the round trip, another screen or device rewrites A
    disk.set(FILE_A, BODY_A_SYNCED);

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    releaseWrites();

    await waitFor(() => expect(shell?.toast()?.message).toContain(TITLE_A), { timeout: 3000 });
    const message = shell?.toast()?.message;
    // A, no longer selected, was not reread. Claiming a reread is read as the B on screen
    // having been swapped
    expect(message).not.toMatch(/読み直しました/u);
    // The backup exists and the note is writable. After reopening, Revert can get it back
    expect(message).toMatch(/この端末に控え/u);
    expect(message).toMatch(/開き直/u);
    expect(message).toMatch(/戻す/u);
    // The screen stays on B. A is reread only when it is reopened
    expect(titleInput().value).toBe(TITLE_B);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("譲る前に打った行");
  });

  // What Stale says depends on whether a reread happened, yet it used to be decided from the
  // state before the reread. When the reread cannot read and turns back, the typed body is
  // still on screen while the message claims a reload, and the reader assumes what is shown
  // came from disk and stops copying it out
  it("does not claim a reload that the read never delivered", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n譲る前に打った行`);
    duringSave = () => {
      duringSave = undefined;
      // Another device rewrites it, and on top of that this device's reread does not go through
      disk.set(FILE_A, BODY_A_SYNCED);
      readFails = true;
    };

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/別の場所で書き換えられていた/u), {
      timeout: 3000,
    });
    // The editor was not rebuilt. What is on screen is still the typed body, and nothing from
    // disk is on it, so no reread can be claimed
    expect(screen.getByText(TEXT_A)).toBeDefined();
    expect(screen.queryByText("他の端末で足された行")).toBeNull();
    expect(shell?.toast()?.message).not.toMatch(/読み直しました/u);
    // The backup exists. Say it can be copied out while it is still on screen
    expect(shell?.toast()?.message).toMatch(/この端末に控え/u);
    expect(shell?.toast()?.message).toMatch(/写して/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("譲る前に打った行");
  });

  // When the backup could not be kept and the reread failed as well. Saying the draft is lost
  // while the typed body is still on screen makes the reader give up and close it
  it("does not say the draft is gone while it is still on screen", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    onTestFinished(() => setItem.mockRestore());
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n控えられなかった行`);
    duringSave = () => {
      duringSave = undefined;
      disk.set(FILE_A, BODY_A_SYNCED);
      readFails = true;
    };

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/写して/u), { timeout: 3000 });
    // The editor was not rebuilt. The typed body is still on screen, so we do not say it is lost
    expect(screen.getByText(TEXT_A)).toBeDefined();
    expect(screen.queryByText("他の端末で足された行")).toBeNull();
    expect(shell?.toast()?.message).not.toMatch(/失われました/u);
  });

  // Moving to the next note before the reread answers makes the reread be dropped. Wording it
  // from what was on screen before yielding claims a reload for that note while a different
  // note is on screen
  it("names the note it yielded when the screen moved on during the read", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n譲る前に打った行`);
    duringSave = () => {
      duringSave = undefined;
      disk.set(FILE_A, BODY_A_SYNCED);
      // Hold the reread that follows the yield
      blockReads();
    };

    // Where the reread took off: one on opening plus one after the yield
    await waitFor(() => expect(countOf("read_note")).toBe(2), { timeout: 3000 });
    fireEvent.click(await rowOf(TITLE_B));
    releaseReads();
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));

    await waitFor(() => expect(shell?.toast()?.message).toContain(TITLE_A), { timeout: 3000 });
    // A's reread never reached the screen. Claiming it did is read as the B on screen having
    // been swapped
    expect(shell?.toast()?.message).not.toMatch(/読み直しました/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("譲る前に打った行");
  });

  // A device where the backup itself fails, with `localStorage` full or disabled. The save to
  // disk has already been refused, so promising here that Revert can call it back has the
  // reader believe it, close the note, and lose the only copy with it
  it("warns instead of promising Revert when the backup cannot be written", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    onTestFinished(() => setItem.mockRestore());
    brokenMeta.add(FILE_A);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n退避できなかった行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/失われます/u));
    // Do not say Revert while pointing at a copy that does not exist
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBeNull();
  });

  // Without a backup, the editor must keep the only copy available to copy out.
  it("keeps the stale draft on screen when its backup cannot be written", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    onTestFinished(() => setItem.mockRestore());
    await openNoteA();
    await startEditingBody();
    const editor = screen.getByTestId("editor-body");
    const draft = `${TEXT_A}\n\n控えられなかった行`;
    // The lightweight editor mock forwards changes without editing its DOM.
    editor.textContent = draft;
    typeInEditor?.(draft);
    disk.set(FILE_A, BODY_A_SYNCED);

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/失われます/u), {
      timeout: 3000,
    });
    expect(screen.getByTestId("editor-body")).toBe(editor);
    expect(editor.textContent).toBe(draft);
    expect(screen.queryByText("他の端末で足された行")).toBeNull();
    expect(disk.get(FILE_A)).toBe(BODY_A_SYNCED);
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(shell?.toast()?.message).toMatch(/写してください/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBeNull();
  });

  // A note with broken frontmatter refuses Revert's write for the same reason. Not showing the
  // backup on the grounds that it cannot be written leaves the backup in place with no way
  // anywhere to get it out
  it("shows the backup on screen when the note it belongs to cannot be written", async () => {
    const typed = `# ${TITLE_A}\n\n壊れたノートで打った行`;
    localStorage.setItem(`note-backup:${FILE_A}`, typed);
    brokenMeta.add(FILE_A);
    await openNoteA();

    await runNoteAction("編集前に戻す");

    // What was typed really comes back on screen. From here it can be selected and copied
    await waitFor(() => expect(screen.getByText("壊れたノートで打った行")).toBeDefined());
    expect(shell?.toast()?.message).toMatch(/ディスクには書けない/u);
    // A refused write changes nothing. The backup is still the only copy, so it is not replaced
    expect(disk.get(FILE_A)).toBe(BODY_A);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBe(typed);
  });

  // A note that no longer reads as text also refuses Revert's write. Not showing the backup on
  // the grounds that it cannot be written closes the last way to get it out while the note is
  // open: reopening cannot read the body at all, so there is no next chance
  it("shows the backup on screen when the note it belongs to is no longer text", async () => {
    const typed = `# ${TITLE_A}\n\n読めなくなる前に打った行`;
    localStorage.setItem(`note-backup:${FILE_A}`, typed);
    await openNoteA();
    // After opening, the file became an unreadable byte sequence. The body on screen is still there
    notText.add(FILE_A);

    await runNoteAction("編集前に戻す");

    await waitFor(() => expect(screen.getByText("読めなくなる前に打った行")).toBeDefined());
    expect(shell?.toast()?.message).toMatch(/ディスクには書けない/u);
    expect(disk.get(FILE_A)).toBe(BODY_A);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBe(typed);
  });

  // For a note that becomes writable after a reread, showing the backup on screen is not the
  // end of it. The screen and the disk would silently disagree, and the next save would crush
  // the other side's body with the backup
  it("still refuses to revert when the write is turned down as stale", async () => {
    localStorage.setItem(`note-backup:${FILE_A}`, `# ${TITLE_A}\n\n控えの行`);
    await openNoteA();
    // Between the read and the press, another device rewrote it
    disk.set(FILE_A, BODY_A_SYNCED);

    await runNoteAction("編集前に戻す");

    await waitFor(() => expect(shell?.toast()?.message).toBe("戻せませんでした"));
    expect(screen.queryByText("控えの行")).toBeNull();
    expect(disk.get(FILE_A)).toBe(BODY_A_SYNCED);
  });

  // Restoring is a swap. If the next save pushes out the place to go back to that the revert
  // just created, pressing it again cannot go back
  it("keeps the reverted body reachable after the next save", async () => {
    const bodyOld = "# 会議メモ\n\nいちばん最初の本文";
    localStorage.setItem(`note-backup:${FILE_A}`, bodyOld);
    await openNoteA();

    await runNoteAction("編集前に戻す");
    await waitFor(() => expect(disk.get(FILE_A)).toBe(bodyOld));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBe(BODY_A);

    fireEvent.input(titleInput(), { target: { value: "別の題" } });
    await waitFor(() => expect(countOf("update_draft")).toBe(2), { timeout: 3000 });
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBe(BODY_A);
  });
});

// Codex is another surface of the same view. Only the directory it lives in differs; once
// open, the writing shape is the same as a Note (#255)
describe("Workspace › Codex の面", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  const FILE_C = "20260903_140000.md";
  const TITLE_C = "育てる文書";
  const BODY_C = `# ${TITLE_C}\n\n書き足していく`;

  const addCodex = (): void => {
    disk.set(FILE_C, BODY_C);
    kinds.set(FILE_C, "codex");
  };

  /**
   * `Cmd N` makes a Note and moves to Notes. This surface's new button makes one of the
   * surface it is on, so a badge here means someone who types what the badge says gets a
   * different thing in a different place. The key is not missing; it is not this button's key.
   */
  it("wears no key on its new button, where ⌘N would make the other thing", async () => {
    addCodex();
    renderWorkspace();
    navigateTo?.("/codex");
    await rowOf(TITLE_C);

    expect(screen.getByRole("button", { name: /新規/u }).dataset.hintKey).toBeUndefined();
  });

  it("lists only the notes of its own surface", async () => {
    addCodex();
    renderWorkspace();

    await rowOf(TITLE_A);
    expect(screen.queryByRole("button", { name: new RegExp(TITLE_C, "u") })).toBeNull();

    navigateTo?.("/codex");
    await rowOf(TITLE_C);
    expect(screen.queryByRole("button", { name: new RegExp(TITLE_A, "u") })).toBeNull();
  });

  // A widget or a `[[link]]` knows only the ID, so it arrives at `/notes`. If the target is a
  // Codex, it is forwarded to that surface
  it("forwards ?file= that points at a codex to the Codex surface", async () => {
    addCodex();
    renderWorkspace();
    await rowOf(TITLE_A);

    navigateTo?.(`/?file=${FILE_C}`);

    await rowOf(TITLE_C);
    expect(screen.queryByRole("button", { name: new RegExp(TITLE_A, "u") })).toBeNull();
    await waitFor(() => expect(titleInput().value).toBe(TITLE_C));
  });

  it("makes a codex from the menu after a confirmation and lands on it", async () => {
    await openNoteA();

    await runNoteAction("Codex にする");
    // The action cannot be undone, so nothing moves at the moment it is pressed
    expect(countOf("promote_note_to_codex")).toBe(0);
    fireEvent.click(await screen.findByRole("button", { name: "Codex にする" }));

    await waitFor(() => expect(kinds.get(FILE_A)).toBe("codex"));
    // It landed on the Codex surface, with the same note still open
    await waitFor(() => expect(screen.getByText("Codex")).toBeDefined());
    await rowOf(TITLE_A);
    await waitFor(() => expect(titleInput().value).toBe(TITLE_A));
  });

  // The moment the confirmation appears, the focus is stranded on the row of the menu that
  // just vanished. Arrow keys walk only the menu rows, and leaving them folds the whole menu,
  // so someone who opened it from the keyboard alone can neither press nor cancel the
  // irreversible action
  it("hands the focus to the confirmation the menu just replaced", async () => {
    await openNoteA();

    await runNoteAction("Codex にする");

    const confirm = await screen.findByRole("button", { name: "Codex にする" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  // Promoting while the scheduled save has fired and the write is in flight sends that write
  // to the path from before the move, leaving only the old body in the Codex. Do not move the
  // file until the write has finished
  it("waits for an in-flight save before moving the file", async () => {
    await openNoteA();
    await startEditingBody();
    blockWrites();
    typeInEditor?.(`# ${TITLE_A}\n\n足した行`);
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });

    await runNoteAction("Codex にする");
    fireEvent.click(await screen.findByRole("button", { name: "Codex にする" }));
    await sleep(100);
    expect(countOf("promote_note_to_codex")).toBe(0);

    releaseWrites();
    await waitFor(() => expect(countOf("promote_note_to_codex")).toBe(1));
    expect(calls.findIndex((c) => c.cmd === "promote_note_to_codex")).toBeGreaterThan(
      calls.findIndex((c) => c.cmd === "update_draft"),
    );
  });

  it("offers no way back from a codex", async () => {
    addCodex();
    renderWorkspace();
    navigateTo?.("/codex");
    fireEvent.click(await rowOf(TITLE_C));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_C));

    await openNoteMenu();

    await screen.findByRole("menuitem", { name: /読み取り専用にする/u });
    expect(screen.queryByRole("menuitem", { name: "Codex にする" })).toBeNull();
  });

  // A folded-corner page at the right edge of the row, left of the date. The number inside is
  // the version count and the frame colour says whether it has moved on. A Note row has none
  it("marks each codex row with a page that counts its versions", async () => {
    addCodex();
    versions.set(FILE_C, [{ id: "v1", message: null, body: BODY_C }]);
    renderWorkspace();
    navigateTo?.("/codex");

    await rowOf(TITLE_C);
    expect(markOf(TITLE_C)?.dataset.state).toBe("clean");
    expect(markOf(TITLE_C)?.querySelector(".page-mark-count")?.textContent).toBe("1");

    disk.set(FILE_C, `${BODY_C}\n\n動いた`);
    shell?.refreshData();
    await waitFor(() => expect(markOf(TITLE_C)?.dataset.state).toBe("dirty"));

    navigateTo?.("/");
    await rowOf(TITLE_A);
    expect(markOf(TITLE_A)).toBeNull();
  });

  it("creates a new document in the surface it is on", async () => {
    addCodex();
    renderWorkspace();
    navigateTo?.("/codex");
    await rowOf(TITLE_C);

    fireEvent.click(screen.getByRole("button", { name: /新規/u }));

    await waitFor(() => expect(countOf("create_draft")).toBe(1));
    expect(calls.find((c) => c.cmd === "create_draft")?.args.kind).toBe("codex");
  });
});

describe("Workspace › Codex の版", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  const FILE_C = "20260903_140000.md";
  const FILE_D = "20260903_150000.md";
  const TITLE_C = "育てる文書";
  const TEXT_C = "書き足していく";
  const BODY_C = `# ${TITLE_C}\n\n${TEXT_C}`;
  const TITLE_D = "もう 1 本";

  /** Gets as far as one Codex being open. */
  async function openCodexC(): Promise<void> {
    disk.set(FILE_C, BODY_C);
    kinds.set(FILE_C, "codex");
    renderWorkspace();
    navigateTo?.("/codex");
    fireEvent.click(await rowOf(TITLE_C));
    await waitFor(() => {
      expect(screen.getByText(TEXT_C)).toBeDefined();
      expect(editorBody().isContentEditable).toBe(true);
    });
  }

  // A version is a mark a person cuts. Neither a save nor moving to another note triggers one
  it("never commits a version on its own", async () => {
    disk.set(FILE_D, `# ${TITLE_D}\n\n本文`);
    kinds.set(FILE_D, "codex");
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    await startEditingBody();
    typeInEditor?.(`# ${TITLE_C}\n\n${TEXT_C}\n\n足した行`);
    await waitFor(() => expect(writesTo(FILE_C)).toHaveLength(1), { timeout: 3000 });
    fireEvent.click(await rowOf(TITLE_D));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_D));

    expect(countOf("commit_note_version")).toBe(0);
    expect(versions.get(FILE_C)).toBeUndefined();
  });

  // The history compares the body on disk against the versions. Opening it with keystrokes that
  // exist only on screen makes Revert erase them, putting them neither into the before-restore
  // version nor into the draft
  it("flushes pending edits before showing history", async () => {
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    await startEditingBody();
    typeInEditor?.(`# ${TITLE_C}\n\n${TEXT_C}\n\n足した行`);
    await runNoteAction("履歴");

    // By the time the panel is open, what was typed is already on disk
    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());
    expect(writesTo(FILE_C)).toHaveLength(1);
    expect(disk.get(FILE_C)).toContain("足した行");
  });

  // What is committed is the body on disk. Without waiting for a save that has fired and is in
  // flight, we claim to have committed a version that is missing the last keystroke
  it("waits for an in-flight save before committing", async () => {
    await openCodexC();
    await startEditingBody();
    blockWrites();
    typeInEditor?.(`# ${TITLE_C}\n\n${TEXT_C}\n\n足した行`);
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });

    await runNoteAction("版を刻む");
    await sleep(100);
    expect(countOf("commit_note_version")).toBe(0);

    releaseWrites();
    await waitFor(() => expect(countOf("commit_note_version")).toBe(1));
    expect(writesTo(FILE_C)).toHaveLength(1);
    expect(versions.get(FILE_C)?.[0]?.body).toContain("足した行");
  });

  // Versions are committed on other devices too. If a sync reread freshens the body and the
  // list while only the version count on the meta line stays stale, it cannot be trusted
  it("refreshes the version status when data changes elsewhere", async () => {
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    versions.set(FILE_C, [{ id: "v1", message: "別の端末で", body: BODY_C }]);
    shell?.refreshData();

    await waitFor(() => expect(metaLine()?.textContent).toBe("版 1"));
  });

  // Moving a Note to Codex keeps `[[ID]]` pointing at the same ID. With a resolution table
  // narrowed by surface, the link's title would vanish the moment it moved and it would drop
  // out of completion too
  it("resolves [[links]] and offers completion across both surfaces", async () => {
    disk.set(FILE_C, BODY_C);
    kinds.set(FILE_C, "codex");
    renderWorkspace();
    fireEvent.click(await rowOf(TITLE_A));
    await waitFor(() => expect(editorBody().isContentEditable).toBe(true));

    expect(editorBody().dataset.noteLinks?.split(",")).toContain(FILE_C.replace(/\.md$/u, ""));
  });

  // No message is asked for. It commits the moment it is pressed, the toast summarises it, and
  // during the grace period it can be undone. The undo only deletes the version file; it does
  // not touch the body
  it("commits at once without a message and can be undone from the toast", async () => {
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    await runNoteAction("版を刻む");

    await waitFor(() => expect(countOf("commit_note_version")).toBe(1));
    expect(calls.find((c) => c.cmd === "commit_note_version")?.args).toStrictEqual({
      filename: FILE_C,
      message: null,
    });
    // The history gains one dot as well: the hollow one for the draft plus the filled one for
    // the version. The row just committed enters with a hop, so only that one row is marked
    await waitFor(() => expect(document.querySelector(".history-row--fresh")).not.toBeNull());
    await waitFor(() => expect(metaLine()?.textContent).toBe("版 1"));
    expect(document.querySelectorAll(".history-panel .history-dot")).toHaveLength(2);
    expect(shell?.toast()?.message).toBe("版 1 を刻みました");
    expect(shell?.toast()?.detail).toBe(`${BODY_C.length} B`);

    shell?.toast()?.undo?.();

    await waitFor(() => expect(countOf("delete_note_version")).toBe(1));
    expect(calls.find((c) => c.cmd === "delete_note_version")?.args).toStrictEqual({
      filename: FILE_C,
      id: "v1",
    });
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));
    expect(disk.get(FILE_C)).toBe(BODY_C);
  });

  it("commits from the keyboard too", async () => {
    await openCodexC();

    fireEvent.keyDown(globalThis, { key: "k", metaKey: true, shiftKey: true });

    await waitFor(() => expect(countOf("commit_note_version")).toBe(1));
  });

  // Opening the history does not remove the body. A panel stands up on the right with the
  // newest version selected, and the difference from that version becomes marks in the body's
  // gutter. The editor folds away and the body becomes read-only
  it("opens the history beside the body with the latest version selected", async () => {
    await openCodexC();
    versions.set(FILE_C, [
      { id: "v2", message: null, body: BODY_C },
      { id: "v1", message: null, body: `# ${TITLE_C}\n\n最初の一行` },
    ]);

    await runNoteAction("履歴");

    const newest = await versionRow(2);
    await waitFor(() => expect(newest.getAttribute("aria-current")).toBe("true"));
    expect(screen.queryByTestId("editor-body")).toBeNull();
    // The newest version equals the draft. No mark is raised, and the draft row says so
    expect(document.querySelector(".history-row--draft")?.textContent).toContain("同じ内容");
    expect(screen.getByText(TEXT_C)).toBeDefined();
    expect(document.querySelector(".diff-mark")).toBeNull();
    // The button that restores the selected version is only under that row
    expect(screen.getByRole("button", { name: "版 2 に戻す" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "版 1 に戻す" })).toBeNull();

    fireEvent.click(await versionRow(1));

    await waitFor(() => {
      expect(document.querySelectorAll(".diff-mark--del").length).toBeGreaterThan(0);
      expect(document.querySelectorAll(".diff-mark--add").length).toBeGreaterThan(0);
    });
    // The comparison against version 2 from the moment it opened ran first. What we read is
    // the one after the press
    expect(calls.findLast((c) => c.cmd === "diff_note_versions")?.args).toStrictEqual({
      filename: FILE_C,
      from: "v1",
    });
    // A deleted line is one that exists only in the selected version. It is slotted into the
    // draft body so it can be read
    expect(screen.getByText("最初の一行")).toBeDefined();
    expect(screen.getByText(TEXT_C)).toBeDefined();
    // The meta line says what is being compared and how many lines moved. The line counts come
    // from the diff already read, so not one extra IPC call is made
    await waitFor(() =>
      expect(document.querySelector(".detail-compare-status")?.textContent).toBe(
        "版 1 と比較中 · 3 行追加 · 3 行削除 · 読み取り専用",
      ),
    );

    // Esc closes it. The panel folds away and the editor comes back
    fireEvent.keyDown(globalThis, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
  });

  // The newest version selected on opening comes from the list reread at that moment. Choosing
  // from the list already at hand would open the one that is a version behind whenever another
  // device has committed a newer one
  it("selects the version that is newest at the moment the history opens", async () => {
    versions.set(FILE_C, [{ id: "v1", message: null, body: BODY_C }]);
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版 1"));

    versions.set(FILE_C, [
      { id: "v2", message: null, body: BODY_C },
      { id: "v1", message: null, body: BODY_C },
    ]);
    await runNoteAction("履歴");

    const newest = await versionRow(2);
    await waitFor(() => expect(newest.getAttribute("aria-current")).toBe("true"));
  });

  // The history button exists only on a Codex, and the same button opens and folds it. It never
  // opens on hover: 320px must not appear in passing beside a writing hand
  it("opens and folds the panel from the one history button, never on hover", async () => {
    await openCodexC();

    const button = screen.getByRole("button", { name: "履歴" });
    expect(document.querySelector(".history-panel--open")).toBeNull();

    // Merely moving onto it does not open it
    fireEvent.pointerEnter(document.querySelector(".history-panel") as HTMLElement);
    await sleep(50);
    expect(document.querySelector(".history-panel--open")).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // With no versions, the next move, committing one, is right there
    expect(screen.getByText("まだ版がありません。いまの本文が最初の版になります。")).toBeDefined();

    // The same button folds it. The close button and Esc arrive at the same place
    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());

    teardownWorkspace();
    await setupWorkspace();
    await openNoteA();
    expect(document.querySelector(".history-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "履歴" })).toBeNull();
  });

  /**
   * The panel never opens on hover, so while there was no key the only way in was one button.
   * Now that a badge appears at its shoulder when `Cmd` is held, that key must work.
   */
  it("opens and folds the history from ⌘⇧H", async () => {
    await openCodexC();

    fireEvent.keyDown(editorBody(), { key: "H", metaKey: true, shiftKey: true });

    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());

    fireEvent.keyDown(globalThis, { key: "H", metaKey: true, shiftKey: true });

    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());
  });

  // The badge that floats at the shoulder while `Cmd` is held. It appears on every way in
  // that has a key which works
  it("wears its key on the shoulder of the history button", async () => {
    await openCodexC();

    expect(screen.getByRole("button", { name: "履歴" }).dataset.hintKey).toBe(
      shortcutLabel("noteHistory"),
    );
  });

  // The close button arrives where Esc does, so whoever opened it does not hunt for a way to close
  it("folds the panel from its own close button", async () => {
    await openCodexC();
    versions.set(FILE_C, [{ id: "v1", message: null, body: BODY_C }]);

    await runNoteAction("履歴");
    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());

    fireEvent.click(document.querySelector(".history-close") as HTMLElement);

    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
  });

  it("restores a version with the revision it read and swaps the body in", async () => {
    await openCodexC();
    const OLD_BODY = `# ${TITLE_C}\n\n最初の一行`;
    versions.set(FILE_C, [{ id: "v1", message: "最初の骨組み", body: OLD_BODY }]);

    await runNoteAction("履歴");
    fireEvent.click(await versionRow(1));
    fireEvent.click(await screen.findByRole("button", { name: "版 1 に戻す" }));

    await waitFor(() => expect(countOf("restore_note_version")).toBe(1));
    const args = calls.find((c) => c.cmd === "restore_note_version")?.args;
    expect(args?.filename).toBe(FILE_C);
    expect(args?.id).toBe("v1");
    // Writes with the revision read at the time. If it was rewritten elsewhere, core refuses
    expect(args?.revision).toBe(revisionOf(BODY_C));
    // The restored body appears on screen and the history folds away
    await waitFor(() => expect(screen.getByText("最初の一行")).toBeDefined());
    expect(document.querySelector(".history-panel--open")).toBeNull();
    // The pre-restore draft becomes the newest version, and the restored body differs from it,
    // so a distance is shown
    await waitFor(() => expect(metaLine()?.textContent).toMatch(/^版 2 から /u));
  });

  // The restore write can go through while the reread that follows never reaches the screen.
  // The screen then holds the pre-restore body while only the revision is the post-restore one,
  // and saving the next keystroke walks straight past core's check and silently crushes the
  // version just restored
  it("does not claim a restore the screen never received, nor overwrite it on the next save", async () => {
    await openCodexC();
    const OLD_BODY = `# ${TITLE_C}\n\n最初の一行`;
    versions.set(FILE_C, [{ id: "v1", message: "最初の骨組み", body: OLD_BODY }]);

    await runNoteAction("履歴");
    fireEvent.click(await versionRow(1));
    // The restore write goes through, but the reread that follows cannot read the disk
    readFails = true;
    fireEvent.click(await screen.findByRole("button", { name: "版 1 に戻す" }));

    await waitFor(() => expect(countOf("restore_note_version")).toBe(1));
    expect(disk.get(FILE_C)).toBe(OLD_BODY);
    // Do not claim a restore. Say that it could not be put on screen
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/画面に出せませんでした/u));
    expect(shell?.toast()?.message).not.toMatch(/戻す前の下書きは履歴にあります/u);
    // What is on screen is still the pre-restore body
    expect(screen.getByText(TEXT_C)).toBeDefined();

    // Even writing more into that body leaves the version just restored intact
    readFails = false;
    await waitFor(() => expect(editorBody().isContentEditable).toBe(true));
    await startEditingBody();
    typeInEditor?.(`${TEXT_C}\n\n足した行`);
    await waitFor(() => expect(writesTo(FILE_C)).toHaveLength(1), { timeout: 3000 });
    expect(disk.get(FILE_C)).toBe(OLD_BODY);
  });

  it("cannot restore into a read-only codex", async () => {
    await openCodexC();
    versions.set(FILE_C, [{ id: "v1", message: "最初の骨組み", body: "# x" }]);
    await runNoteAction("読み取り専用にする");
    await waitFor(() => expect(screen.queryByTestId("editor-body")).toBeNull());

    await runNoteAction("履歴");
    fireEvent.click(await versionRow(1));

    const restore = await screen.findByRole<HTMLButtonElement>("button", { name: "版 1 に戻す" });
    expect(restore.disabled).toBe(true);
  });

  // A phone has no width to stand a panel in. The history is not a sheet but its own screen
  // that replaces the body, and pressing a version returns to the body in compare mode
  it("gives a phone a history screen instead of a panel", async () => {
    await page.viewport(390, 844);
    versions.set(FILE_C, [
      { id: "v2", message: null, body: BODY_C },
      { id: "v1", message: null, body: `# ${TITLE_C}\n\n最初の一行` },
    ]);
    await openCodexC();

    await runNoteAction("履歴");

    await waitFor(() => expect(document.querySelector(".history-panel--screen")).not.toBeNull());
    // The whole screen is replaced, so no body remains. Restore is not under the row either;
    // the compare bar carries it
    expect(screen.queryByTestId("editor-body")).toBeNull();
    expect(document.querySelector(".detail-body")).toBeNull();
    expect(screen.queryByRole("button", { name: "版 2 に戻す" })).toBeNull();

    fireEvent.click(await versionRow(1));

    // Back to the body in compare mode. Gutter marks are raised, and the bar below says what
    // is being compared
    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".compare-bar");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(document.querySelector(".history-panel--screen")).toBeNull();
    expect(bar.querySelector(".compare-bar-title")?.textContent).toBe("版 1 と比較中");
    await waitFor(() =>
      expect(bar.querySelector(".compare-bar-detail")?.textContent).toBe(
        "3 行追加 · 3 行削除 · 読み取り専用",
      ),
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".diff-mark--add").length).toBeGreaterThan(0),
    );
    // While comparing it is read-only. That is not shown on the meta line, so the bar does not
    // say it twice
    expect(document.querySelector(".detail-compare-status")).toBeNull();

    // The history button on the bar goes back to the screen
    fireEvent.click(within(bar).getByRole("button", { name: "履歴" }));
    await waitFor(() => expect(document.querySelector(".history-panel--screen")).not.toBeNull());

    // The back arrow returns to the body. Compare mode is still on, so the bar stays. Looking
    // it up by its screen-reader name also checks that the arrow names where it goes back to
    fireEvent.click(screen.getByLabelText("本文に戻る"));
    await waitFor(() => expect(document.querySelector(".compare-bar")).not.toBeNull());

    // The close button ends the comparison. The editor comes back
    fireEvent.click(document.querySelector(".compare-bar-close") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".compare-bar")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
  });
});
