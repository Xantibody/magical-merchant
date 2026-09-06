import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useNavigate } from "@solidjs/router";
import { createEffect, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Editor } from "@milkdown/kit/core";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import Workspace from "./Workspace";

// 本物の Milkdown は ProseMirror 一式を連れてくる。ここで見たいのは
// 「どのノートに何を書くか」という判断だけなので、開いているという事実と
// 打鍵の入り口だけを持つ板に差し替える。`.ProseMirror` と contenteditable は
// 本物と揃える — 「いま書いている最中か」の判断がカーソルの居場所を見る。
// 立ち上がりも本物と同じく 1 拍遅れる。マウントした瞬間には ProseMirror も
// onEditorReady も無く、それを待たずに置いたカーソルは空を切る
let typeInEditor: ((markdown: string) => void) | undefined;
vi.mock(import("../components/MilkdownEditor"), () => ({
  default: (props: {
    defaultValue?: string;
    onChange?: (markdown: string) => void;
    onEditorReady?: (editor?: Editor) => void;
  }): JSX.Element => {
    typeInEditor = props.onChange;
    const el = document.createElement("div");
    el.dataset.testid = "editor-body";
    el.textContent = props.defaultValue ?? "";
    const ready = setTimeout(() => {
      el.className = "ProseMirror";
      el.contentEditable = "true";
      props.onEditorReady?.({} as Editor);
    }, 0);
    // 本文が入れ替わると作り直される。畳むときに「もう居ない」を返すのも本物どおり
    onCleanup(() => {
      clearTimeout(ready);
      props.onEditorReady?.();
    });
    return el;
  },
}));

// エディタが立つと出る道具の列。ここで見たいものは無い
vi.mock(import("../components/MarkdownToolbar"), () => ({
  default: (): JSX.Element => null,
}));

// markmap は d3 を連れてくる。ここで見たいのは「並んでいるか」と「いつ描き直すか」だけ
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

const FILE_A = "20260903_120000.md";
const FILE_B = "20260903_130000.md";
const TITLE_A = "会議メモ";
const TEXT_A = "ここまで書いた";
const BODY_A = `# ${TITLE_A}\n\n${TEXT_A}`;
/** 他の端末が書いた版。同期で降ってきたことにする。 */
const BODY_A_SYNCED = "# 会議メモ (同期後)\n\n他の端末で足された行";
const TITLE_B = "買い物";
const BODY_B = `# ${TITLE_B}\n\n牛乳`;

/** ディスクの中身(filename → 全文)。テストの途中で外から書き換わったことにする。 */
let disk: Map<string, string>;
/** frontmatter のうち一覧と詳細が読むぶん。書いていないノートは既定のまま。 */
let meta: Map<string, { tags?: string[]; view?: string }>;
/** 呼ばれたコマンドと引数。どのノートに何が書かれたかをこれで見る。 */
let calls: { cmd: string; args: Record<string, unknown> }[];
/** read_note を止めておく関門。応答が届く前の操作を再現する。 */
let readGate: Promise<void> | undefined;
let openGate: (() => void) | undefined;
/** update_draft が飛んでいる間に起きること。往復の途中の打鍵を再現する。 */
let duringSave: (() => void) | undefined;
/** update_draft を止めておく関門。書き込みが遅い端末を再現する。 */
let writeGate: Promise<void> | undefined;
let openWriteGate: (() => void) | undefined;

/** 本文の指紋。core と同じ「読んだ版で書く」照合をテストでも同じ形で行う。 */
const revisionOf = (body: string): string => `rev:${body}`;

const countOf = (command: string): number => calls.filter((c) => c.cmd === command).length;

/** そのノートへの書き込みだけを取り出す。隣のノートへ着地していないかを見る。 */
const writesTo = (filename: string): Record<string, unknown>[] =>
  calls
    .filter((c) => c.cmd === "update_draft" && String(c.args.filePath).endsWith(filename))
    .map((c) => c.args);

/** 一覧の 1 行。時刻はファイル名(= ID)から導く。 */
const summaryOf = (filename: string): Record<string, unknown> => ({
  path: `/data/notes/${filename}`,
  filename,
  time:
    `${filename.slice(0, 4)}-${filename.slice(4, 6)}-${filename.slice(6, 8)}` +
    `T${filename.slice(9, 11)}:${filename.slice(11, 13)}:${filename.slice(13, 15)}+09:00`,
  tags: meta.get(filename)?.tags ?? [],
  preview: disk.get(filename) ?? "",
  // core は書いていないキーを落とす。一覧の読み手が undefined を見る形に揃える
  ...(meta.get(filename)?.view ? { view: meta.get(filename)?.view } : {}),
});

const WRITE_COMMANDS = ["update_draft", "create_draft", "set_note_view", "delete_note"];

/** Tauri から返る SaveError の形。フロントが見るのは `kind` だけ。 */
const saveError = (kind: string, message: string): Error =>
  Object.assign(new Error(message), { kind });

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_notes: () => [...disk.keys()].map((filename) => summaryOf(filename)),
  list_templates: () => [],
  find_backlinks: () => [],
  read_note: async ({ filename }) => {
    await readGate;
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
  update_draft: async ({ filePath, body, revision }) => {
    duringSave?.();
    await writeGate;
    const filename = String(filePath).split("/").at(-1) ?? "";
    const current = disk.get(filename);
    if (current === undefined) {
      throw saveError("other", `note not found: ${filename}`);
    }
    // core と同じ照合。読んでから誰かが書き換えていれば、その上に書かない
    if (typeof revision === "string" && revision !== revisionOf(current)) {
      throw saveError("stale", `Stale: ${filename} changed since it was read`);
    }
    disk.set(filename, String(body));
    return revisionOf(String(body));
  },
  delete_note: ({ filename }) => {
    disk.delete(String(filename));
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

/** ウィジェットの `?file=` を流し込めるように、ルータの中から navigate を借りる。 */
function WorkspaceRoute(): JSX.Element {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return <Workspace />;
}

/** 一覧だけを描く。詳細を開かないので、見えているのは行そのもの。 */
function renderWorkspace(): void {
  render(() => (
    <ShellProvider>
      <CaptureShell />
      <MemoryRouter>
        <Route path="/" component={WorkspaceRoute} />
      </MemoryRouter>
    </ShellProvider>
  ));
}

const rowOf = (title: string): Promise<HTMLElement> =>
  screen.findByRole("button", { name: new RegExp(title, "u") });

/** 本文のエディタ。立ち上がりきるまでは contenteditable にならない。 */
function editorBody(): HTMLElement {
  return screen.getByTestId("editor-body");
}

/** ノート A を 1 件開いた状態まで進める。狭い画面では詳細を開くまで本文が出ない。 */
async function openNoteA(): Promise<void> {
  renderWorkspace();
  fireEvent.click(await rowOf(TITLE_A));
  // 本文が届き、そのエディタが立ち上がりきるまで。エディタは本文が届いて
  // から立つので、字が出ていて contenteditable になったところを待つ
  await waitFor(() => {
    expect(screen.getByText(TEXT_A)).toBeDefined();
    expect(editorBody().isContentEditable).toBe(true);
  });
}

function titleInput(): HTMLInputElement {
  return screen.getByPlaceholderText<HTMLInputElement>("タイトル");
}

/** 「起きないこと」を見るための間。waitFor は起きるまで待つので使えない。 */
function sleep(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 本文にカーソルを置く。エディタは開いた時点から在るので、これは
 * 「書き始める」ではなく「書いている人の手をそこに置く」だけ。
 */
async function startEditingBody(): Promise<void> {
  fireEvent.keyDown(titleInput(), { key: "Enter" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("editor-body")));
}

/** 「…」を開いてから、その中の 1 行を押す。 */
async function runNoteAction(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "このノートの操作" }));
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name, "u") }));
}

/** 「新規」→「空のノート」。テンプレのシートを経由するのは本物と同じ順序。 */
async function createEmptyNote(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /新規/u }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /空のノート/u }));
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

/** ディスク・IPC・画面の幅を、テスト 1 本ぶんの初期状態に戻す。 */
async function setupWorkspace(): Promise<void> {
  // 一覧と詳細が並ぶ幅。編集中に「+ 新規」を押せるのはこの形のときだけで、
  // 携帯の幅では一覧ペインごと隠れている
  await page.viewport(1280, 800);
  disk = new Map([[FILE_A, BODY_A]]);
  meta = new Map();
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
  // 止めたままの読み書きを解いてから畳む。待ち続ける promise を残さない
  releaseReads();
  releaseWrites();
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

describe("Workspace › 一覧の行", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // タグは本文にも書いてある。行にも並べると、選ぶ前に読む字が二重になり、
  // 長い題ほど先に切られる
  it("keeps a row down to its title and one stamp", async () => {
    meta.set(FILE_A, { tags: ["sf6", "vega"] });
    renderWorkspace();

    const row = await rowOf(TITLE_A);

    expect(row.textContent).not.toContain("sf6");
    // 右端に残るのは 1 つだけ。今日なら時刻、それ以前なら日付
    expect(row.textContent).toMatch(new RegExp(`^${TITLE_A}(\\d\\d:\\d\\d|\\d\\d/\\d\\d)$`, "u"));
  });

  // 書けないノートだと開くまで分からないと、書こうとしてから気づくことになる
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
});

describe("Workspace › 常時編集", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // 「読む姿」と「書く姿」を行き来させると、書くたびに 1 手ぶん遠くなる
  it("opens a note with the editor already in it", async () => {
    await openNoteA();

    expect(screen.getByTestId("editor-body").textContent).toBe(TEXT_A);
  });

  // 読むだけのノートは、書ける合図をどこにも出さない
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

  // 鍵をかけた瞬間に読む姿へ変わる。そこに出るのが読み込み直後の本文だと、
  // さっき打った字が消えたように見える
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

  // 昇格した記録は、開いた瞬間に続きを打てる形で渡す。本文が届いた時点では
  // エディタがまだ立っていないので、そこで置いたカーソルは空を切る
  it("puts the caret in a promoted note once its editor is up", async () => {
    renderWorkspace();
    await rowOf(TITLE_A);

    navigateTo?.(`/?file=${FILE_A}&edit=1`);

    await waitFor(() => expect(document.activeElement).toBe(editorBody()));
    expect(editorBody().textContent).toBe(TEXT_A);
  });

  // 置き換えると、書いていた本文が図を見ているあいだ消える
  it("lays the map beside the note instead of over it", async () => {
    await openNoteA();

    await runNoteAction("マップを並べる");

    await waitFor(() => expect(screen.getByTestId("mindmap")).toBeDefined());
    expect(screen.getByTestId("editor-body")).toBeDefined();
  });

  // 並べた図を打鍵のたびに組み替えると、書いている横で枝が跳ね続ける。
  // 手が止まってから追いつかせる
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

  // 隣のノートを開いたときまで待たせると、前のノートの図が 1 拍残る
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

  // macOS の ⌘↑ / ⌘↓ は文頭・文末へ飛ぶキー。ブラウザ既定の動きなので
  // エディタは preventDefault せず、カーソルの居場所で見分けるしかない
  it("leaves ⌘↑ and ⌘↓ to the caret while the body is being written", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(screen.getByTestId("editor-body"), { key: "ArrowDown", metaKey: true });
    fireEvent.keyDown(screen.getByTestId("editor-body"), { key: "ArrowUp", metaKey: true });

    await sleep(100);
    expect(titleInput().value).toBe(TITLE_A);
  });

  // 入力欄の ⌘⇧Z は打ち直し。題を直している手元で、ノートごと巻き戻さない
  it("leaves ⌘⇧Z to the title field's redo while the title is being typed", async () => {
    localStorage.setItem(`note-backup:${FILE_A}`, `# ${TITLE_A}\n\n前の本文`);
    await openNoteA();

    fireEvent.keyDown(titleInput(), { key: "Z", metaKey: true, shiftKey: true });

    await sleep(100);
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });
});

describe("Workspace › 保存の見え方", () => {
  beforeEach(setupWorkspace);
  afterEach(teardownWorkspace);

  // 緑の「保存しました」が点きっぱなしだと、書いているあいだじゅう視界の端が
  // 光る。2 秒で「何時に保存したか」に落ち着かせる
  it("settles from the green tick onto the time it saved at", async () => {
    await openNoteA();

    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });

    await screen.findByText("保存しました", {}, { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/に保存$/u)).toBeDefined(), { timeout: 4000 });
  });

  // 2 秒の緑はそのノートの持ち物。隣へ移ったあとに落ちてくる「21:40 に保存」は、
  // 保存していないノートに保存したと言うことになる
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

  // 書き込みが遅い端末では、隣へ移ったあとに前のノートの保存が着地する。
  // その合図を出すと、開いたばかりのノートが「保存しました」と言う
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

  // 同期でダウンロードされた変更が、開いたままのノートに届く
  it("reloads the open note when dataVersion increases", async () => {
    await openNoteA();
    expect(titleInput().value).toBe(TITLE_A);

    disk.set(FILE_A, BODY_A_SYNCED);
    shell?.refreshData();

    await waitFor(() => expect(screen.getByText("他の端末で足された行")).toBeDefined());
    expect(titleInput().value).toBe("会議メモ (同期後)");
    expect(countOf("read_note")).toBe(2);
    // 読み直しは読むだけ。ここで書き戻すと、相手の版を自分の版で潰す
    for (const command of WRITE_COMMANDS) {
      expect(countOf(command)).toBe(0);
    }
  });

  // エディタを開いたまま本文を差し替えると、カーソル・選択・IME が消える
  it("leaves the body alone while the editor is open", async () => {
    await openNoteA();
    await startEditingBody();
    const readsBefore = countOf("read_note");

    disk.set(FILE_A, BODY_A_SYNCED);
    shell?.refreshData();

    // 一覧の読み直しが届くまで待つ。そのうえで本文だけが読み直されないことを見る
    await screen.findByText("会議メモ (同期後)");
    expect(countOf("read_note")).toBe(readsBefore);
    expect(screen.getByTestId("editor-body").textContent).toBe(TEXT_A);
    for (const command of WRITE_COMMANDS) {
      expect(countOf(command)).toBe(0);
    }
  });

  // 自動保存が起きたあとも「保存待ち」のままだと、同期の版が二度と画面に出ない
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

  // 「+ 新規」は編集中でも押せる。押した瞬間に選択だけが移ると、
  // 次の保存が新しいノートに前のノートの本文を書く
  it("keeps the typed body in its own note when a new note takes the selection", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\nもう一行`);

    await createEmptyNote();
    await waitFor(() => expect(titleInput().value).toBe(""));

    // 画面を離れると、待っている保存は出しきられる
    cleanup();
    await waitFor(() => expect(countOf("update_draft")).toBe(1));
    expect(writesTo(FILE_B)).toStrictEqual([]);
    expect(disk.get(FILE_A)).toContain("もう一行");
    expect(disk.get(FILE_B)).toBe("");
  });

  // ウィジェットの行から `?file=` で別のノートが開く経路も同じ
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

  // 削除は隣のノートを選ぶ。待っている保存はそれでも「打った本人」に着地する
  it("keeps the typed body in its own note when a delete moves the selection", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\nもう一行`);

    // 隣のノートの本文が届く前にタイトル欄を離れる = 待っている保存を出しきる
    blockReads();
    await runNoteAction("削除");
    fireEvent.change(titleInput(), { target: { value: TITLE_A } });

    // 打った字は消すノートに着地する。隣のノートには何も書かない
    await waitFor(() => expect(disk.get(FILE_A)).toContain("もう一行"), { timeout: 3000 });
    expect(writesTo(FILE_B)).toStrictEqual([]);

    // 5 秒後の本削除はテストの外まで生き残る。UI の「元に戻す」と同じ道で畳む
    await waitFor(() => expect(shell?.toast()?.undo).toBeInstanceOf(Function));
    shell?.toast()?.undo?.();
  });

  // 隣のノートの本文が届くまで、前のノートのエディタと題が画面に残る。
  // そこに打った字は「前のノートの本文 + 打った字」を隣のノートへ書き、
  // 初めて開く相手には revision も無いので core も止められない
  it("does not write what is typed while the next note is still loading", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();

    blockReads();
    fireEvent.click(await rowOf(TITLE_B));
    // 選択は移り、記録の段は B の作成日時を出しているが、本文はまだ A のもの
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

  // 自動保存が先に着地していると、離れるときに「待っている保存」が無い。
  // それでも行の題は変わっているので、一覧は読み直さないと古いまま
  it("refreshes the list on leaving a note whose autosave already landed", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });
    await screen.findByText("保存しました", {}, { timeout: 3000 });
    expect(screen.queryByRole("button", { name: /会議メモ 改/u })).toBeNull();

    fireEvent.click(await rowOf(TITLE_B));

    await expect(rowOf("会議メモ 改")).resolves.toBeDefined();
  });

  // フォーカス復帰の読み直しが飛んでいる間にタップして書き始めると、
  // 画面に出ているのは読む前の本文。保存に添える版もそれに揃っていないと、
  // 相手の版を「読んだつもり」で潰す
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
    // 読んだ版で断られるので、相手の行は残る
    expect(disk.get(FILE_A)).toBe(BODY_A_SYNCED);
  });

  // Stale で退避するのは「飛んでいった写し」ではなく、いま画面にある本文。
  // 往復のあいだに打った字は、まだどこにも残っていない
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

  // 退避して読み直したあとに、その手前で並んだ保存が出てくると、
  // 読み直した版の指紋で古い draft が通ってしまう
  it("drops a save that was queued before the stale reload", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n一回目`);
    disk.set(FILE_A, BODY_A_SYNCED);
    duringSave = () => {
      duringSave = undefined;
      typeInEditor?.(`${TEXT_A}\n\n二回目`);
      // 飛んでいる保存の後ろに、もう 1 回ぶんの保存を並べる
      fireEvent.change(titleInput(), { target: { value: TITLE_A } });
    };

    await waitFor(() => expect(screen.getByText("他の端末で足された行")).toBeDefined(), {
      timeout: 3000,
    });
    // 読み直したあとの保存は通る。それが着く時点までに、並んでいた古い
    // draft が書かれていないことを見る(書かれていれば 3 回になる)
    fireEvent.input(titleInput(), { target: { value: "読み直したあとの題" } });
    await waitFor(() => expect(disk.get(FILE_A)).toContain("読み直したあとの題"), {
      timeout: 3000,
    });
    expect(countOf("update_draft")).toBe(2);
    expect(disk.get(FILE_A)).toBe("# 読み直したあとの題\n\n他の端末で足された行");
  });

  // 復元は入れ替え。戻した直後の「戻る先」を次の保存で押し出すと、
  // もう一度押しても戻れない
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
