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
    noteLinks?: () => { id: string }[];
  }): JSX.Element => {
    typeInEditor = props.onChange;
    const el = document.createElement("div");
    el.dataset.testid = "editor-body";
    el.textContent = props.defaultValue ?? "";
    // `[[` 補完の候補は本物なら入力中に引く。板は ID だけ並べて見せる
    el.dataset.noteLinks = (props.noteLinks?.() ?? []).map((t) => t.id).join(",");
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

/** 自動保存の debounce。Workspace.tsx と揃える。 */
const SAVE_DEBOUNCE_MS = 1000;

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
/** どの置き場に居るか。書いていないノートは Note。 */
let kinds: Map<string, "note" | "codex">;
/** Codex の版(新しい順)。本文ごと持ち、差分はここから作る。 */
let versions: Map<string, { id: string; message: string | null; body: string }[]>;
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
/** 先頭の記録が読めないノート。core がこれに書き込みを断る。 */
let brokenMeta: Set<string>;
/**
 * 中身が文字として読めないノート(不正な UTF-8)。同期や外の道具が置いていった
 * バイト列で、core は読む段で断る — 書き込みも、そのあとの読み直しも。
 */
let notText: Set<string>;
/** read_note を失敗させる。ディスクが一時的に読めない端末を再現する。 */
let readFails: boolean;

/** 本文の指紋。core と同じ「読んだ版で書く」照合をテストでも同じ形で行う。 */
const revisionOf = (body: string): string => `rev:${body}`;

const countOf = (command: string): number => calls.filter((c) => c.cmd === command).length;

/** そのノートへの書き込みだけを取り出す。隣のノートへ着地していないかを見る。 */
const writesTo = (filename: string): Record<string, unknown>[] =>
  calls.filter((c) => c.cmd === "update_draft" && c.args.filename === filename).map((c) => c.args);

/** 一覧の 1 行。時刻はファイル名(= ID)から導く。 */
const summaryOf = (filename: string): Record<string, unknown> => ({
  kind: kinds.get(filename) ?? "note",
  path: `/data/${kinds.get(filename) ?? "notes"}/${filename}`,
  filename,
  time:
    `${filename.slice(0, 4)}-${filename.slice(4, 6)}-${filename.slice(6, 8)}` +
    `T${filename.slice(9, 11)}:${filename.slice(11, 13)}:${filename.slice(13, 15)}+09:00`,
  tags: meta.get(filename)?.tags ?? [],
  preview: disk.get(filename) ?? "",
  // core は書いていないキーを落とす。一覧の読み手が undefined を見る形に揃える
  ...(meta.get(filename)?.view ? { view: meta.get(filename)?.view } : {}),
  // Codex の行だけ版の数と「動いたか」
  ...(kinds.get(filename) === "codex"
    ? {
        version_count: (versions.get(filename) ?? []).length,
        dirty: (versions.get(filename)?.[0]?.body ?? disk.get(filename)) !== disk.get(filename),
      }
    : {}),
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
    // 文字として読めないファイルは読む段で断られる。開き直しても本文は載らない
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
    // core はノートを作り直さない。消えたノートへの保存は探す段で断られる
    if (current === undefined) {
      throw saveError("missing", `Not found: ${name}`);
    }
    // core は中身を読めないファイルには書かない。読み直しでも直らない
    if (notText.has(name)) {
      throw saveError("notText", `Not text: ${name} is not valid UTF-8`);
    }
    // core は記録をでっち上げて書くより断る。読み直しても直らない
    if (brokenMeta.has(name)) {
      throw saveError("broken", `Parse error: ${name}`);
    }
    // core と同じ照合。読んでから誰かが書き換えていれば、その上に書かない
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
  // core の unified diff の形だけ真似る。行の突き合わせはしない
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

/** ウィジェットの `?file=` を流し込めるように、ルータの中から navigate を借りる。 */
function WorkspaceRoute(): JSX.Element {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return <Workspace />;
}

/** 同じ画面の Codex の面。`/codex` に載るのは App.tsx と同じ形。 */
function CodexRoute(): JSX.Element {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return <Workspace kind="codex" />;
}

/** 一覧だけを描く。詳細を開かないので、見えているのは行そのもの。 */
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

/** Codex のメタ行に出る版の数。 */
const metaLine = (): HTMLElement | null => document.querySelector(".detail-version-status");

/**
 * 履歴の版の行。1 行目は「版 N」+ 日時なので、番号のあとに日付の数字が来る —
 * 選んだ行の下に出る「版 N に戻す」ボタンと取り違えないための目印。
 */
const versionRow = (n: number): Promise<HTMLElement> =>
  screen.findByRole("button", { name: new RegExp(`^版 ${n} \\d`, "u") });

/**
 * 一覧の行の角折りページ。読み直した一覧は行を作り直すので、掴んでいた行では
 * なく、いまその題を名乗る行の印を見る。
 */
const markOf = (title: string): HTMLElement | null =>
  screen
    .getByRole("button", { name: new RegExp(title, "u") })
    .querySelector<HTMLElement>(".page-mark");

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

/**
 * 押す。メニューの開閉と行の選択は pointerdown / pointerup で決まる
 * (部品の作法)ので、click だけでは何も起きない。
 */
function press(target: HTMLElement): void {
  fireEvent.pointerDown(target, { button: 0 });
  fireEvent.pointerUp(target, { button: 0 });
}

/** 「…」を開く。返すのは開いたメニュー。 */
function openNoteMenu(): Promise<HTMLElement> {
  press(screen.getByRole("button", { name: "この Note の操作" }));
  return screen.findByRole("menu");
}

/** 「…」を開いてから、その中の 1 行を押す。 */
async function runNoteAction(name: string): Promise<void> {
  // 背骨も「履歴」と名乗る。押すのはメニューの行
  const menu = await openNoteMenu();
  press(await within(menu).findByRole("menuitem", { name: new RegExp(name, "u") }));
}

/** シートの背後を暗くしている幕。role も名前も持たないので class で引く。 */
function templateBackdrop(): Element {
  const found = document.querySelector(".template-picker-backdrop");
  if (!found) {
    throw new Error("expected the sheet to have a backdrop");
  }
  return found;
}

/** 「新規」→「空の Note」。テンプレのシートを経由するのは本物と同じ順序。 */
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

/** ディスク・IPC・画面の幅を、テスト 1 本ぶんの初期状態に戻す。 */
async function setupWorkspace(): Promise<void> {
  // 一覧と詳細が並ぶ幅。編集中に「+ 新規」を押せるのはこの形のときだけで、
  // 携帯の幅では一覧ペインごと隠れている
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

  /**
   * ⌘ を押し続けているあいだ肩に浮かぶ札。一覧の頭の 2 つはどちらもキーを
   * 持っているので、片方にだけ札が出ていると、もう片方はキーが無いように読める。
   */
  it("wears its key on the shoulder of both buttons at the head of the list", async () => {
    renderWorkspace();
    await rowOf(TITLE_A);

    // 綴りは台に依る(macOS は ⌘、他は Ctrl+)。表から引いて、書き写さない
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

  // 触る端末でテンプレートのシートを開く道は「新規」の長押ししかない。
  // 指は押しているあいだ数 px 揺れ続けるので、その揺れで長押しが切れると
  // シートには一生たどり着けず、離した指が空のノートを作る(#253)
  it("opens the template sheet on a long press the finger jitters through", async () => {
    renderWorkspace();
    const newNote = await screen.findByRole("button", { name: /新規/u });

    fireEvent.pointerDown(newNote, { pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(newNote, { pointerType: "touch", clientX: 103, clientY: 102 });
    fireEvent.pointerMove(newNote, { pointerType: "touch", clientX: 99, clientY: 104 });

    // 長押しの 500ms は本物の時間で待つ
    await screen.findByRole("menuitem", { name: /空の Note/u }, { timeout: 2000 });

    // シートが出たあとに離した指の click は飲み込む。開いたうえに
    // 空の Note まで増えていたら、長押しは入り口として使えない
    fireEvent.pointerUp(newNote, { pointerType: "touch", clientX: 99, clientY: 104 });
    fireEvent.click(newNote);
    expect(countOf("create_draft")).toBe(0);
  });

  // シートには取り消しのボタンが無く、幕は開けたボタンごと覆う。その幕は器の
  // 中に居るので部品から見ると内側の押下で、自分で受けないかぎり指だけでは
  // 何かを選ぶまで抜け出せない
  it("closes the template sheet when the finger taps the backdrop", async () => {
    renderWorkspace();
    const newNote = await screen.findByRole("button", { name: /新規/u });

    fireEvent.pointerDown(newNote, { pointerType: "touch", clientX: 100, clientY: 100 });
    await screen.findByRole("menuitem", { name: /空の Note/u }, { timeout: 2000 });
    fireEvent.pointerUp(newNote, { pointerType: "touch", clientX: 100, clientY: 100 });

    fireEvent.click(templateBackdrop());

    await waitFor(() => expect(screen.queryByRole("menuitem", { name: /空の Note/u })).toBeNull());
    // 抜け出しただけ。ノートは増えていない
    expect(countOf("create_draft")).toBe(0);
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

  // 外側を押して閉じるのはメニュー自身の仕事。画面の外(AppLayout)の
  // 一括処理に預けていると、この面だけを描いたときに開いたまま残る
  it("closes the menu when a press lands outside it", async () => {
    await openNoteA();
    await openNoteMenu();
    // 外側の見張りが立つのは開いた次のタスク。人の指はそれより遅い
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

  // ⌘. で開く道があるので、開いた先も指に持ち替えずに辿れる
  it("walks the rows with the arrow keys", async () => {
    await openNoteA();
    const menu = await openNoteMenu();
    // 開いたメニューがまず手を受け取る。辿り始められるのはそこから
    await waitFor(() => expect(document.activeElement).toBe(menu));

    fireEvent.keyDown(menu, { key: "ArrowDown" });

    await waitFor(() =>
      expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]),
    );
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

  // 一覧の行に居るときの ↑↓ は、その一覧の中を動くキー。押した先の行へ
  // フォーカスも移す — 動かさないと、2 度目の ↓ が最初の行から数え直す
  it("steps to the next note on ↓ inside the list and moves focus with it", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    const rowA = await rowOf(TITLE_A);
    rowA.focus();

    fireEvent.keyDown(rowA, { key: "ArrowDown" });

    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    expect(document.activeElement).toBe(await rowOf(TITLE_B));
  });

  // 本文の ↓ はカーソルを 1 行下げるキー。一覧の外で押した矢印は奪わない
  it("leaves a plain ↓ to the caret while the body is being written", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(screen.getByTestId("editor-body"), { key: "ArrowDown" });

    await sleep(100);
    expect(titleInput().value).toBe(TITLE_A);
  });

  // 端で押した ↑ は行き先が無い。preventDefault もしないので、一覧のスクロールに落ちる
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

  // 常時編集なので、ノートを開いているあいだカーソルはほぼ本文の中にある。
  // 本文で効かないキーは、無いのと同じ (#211)
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

  // ⌘I は Milkdown の斜体。書いている最中はそちらが正しいので、こちらは拾わない
  it("leaves ⌘I to the editor's italic while the body is being written", async () => {
    await openNoteA();
    await startEditingBody();

    fireEvent.keyDown(editorBody(), { key: "i", metaKey: true });

    await sleep(100);
    expect(screen.queryByText("作成日時")).toBeNull();
  });

  // 入力欄の ⌘⇧R は何でもない。題を打っている手でも、押したなら戻す
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

  // 緑の「保存しました」が点きっぱなしだと、書いているあいだじゅう視界の端が
  // 光る。2 秒で「何時に保存したか」に落ち着かせる
  it("settles from the green tick onto the time it saved at", async () => {
    await openNoteA();

    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });

    await screen.findByText("保存しました", {}, { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/に保存$/u)).toBeDefined(), { timeout: 4000 });
  });

  /**
   * 広い画面で保存の様子を出すのはボトムバーで、それは画面の外(AppLayout)に
   * ある。受け渡しは shell なので、そこへ着地が届いているかを見る。
   */
  it("hands the landing to the shell for the bar outside this view", async () => {
    await openNoteA();
    expect(shell?.saveState().status).toBe("idle");

    fireEvent.input(titleInput(), { target: { value: "会議メモ 改" } });

    await waitFor(() => expect(shell?.saveState().status).toBe("saved"), { timeout: 3000 });
    await waitFor(() => expect(shell?.saveState().status).toBe("savedAt"), { timeout: 4000 });
    expect(shell?.saveState().at).toMatch(/^\d\d:\d\d$/u);
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

  // 読み直しが失敗しても、画面の本文は入れ替えない。空のエディタを立てると
  // 「空のノート」に見え、次の打鍵が数文字だけの本文をディスクへ書きに行く
  it("keeps the draft on screen when a refresh read fails mid-edit", async () => {
    await openNoteA();

    blockReads();
    readFails = true;
    shell?.refreshData();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n読めなかったあとの行`);
    releaseReads();

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    // エディタは作り直されていない。作り直されると打っていた本文が空に戻る
    expect(screen.getByText(TEXT_A)).toBeDefined();
    // 指紋も読めた版のまま。読み直せなかったのだから進みようがない
    expect(writesTo(FILE_A)[0]?.revision).toBe(revisionOf(BODY_A));
    expect(disk.get(FILE_A)).toContain("読めなかったあとの行");
  });

  // 読めなかったノートには書かない。指紋を持たない保存は core の照合を
  // 素通りするので、打った数文字がそのままファイル全体になる
  it("writes nothing to a note whose body could not be read", async () => {
    readFails = true;
    renderWorkspace();
    fireEvent.click(await rowOf(TITLE_A));
    await waitFor(() => expect(countOf("read_note")).toBe(1));
    // 読みが断られきるまで。ここで空のエディタが立つかどうかを見る
    await sleep(50);

    // 読めなかった本文をエディタに載せない。載せると「空のノート」に見える
    expect(screen.queryByTestId("editor-body")).toBeNull();
    typeInEditor?.("数文字");
    await sleep(SAVE_DEBOUNCE_MS + 500);

    expect(countOf("update_draft")).toBe(0);
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });

  // 記録が壊れたノートは core が書き込みごと断る。読み直しても直らないので、
  // 打った字を退避しておかないと、打鍵のたびに黙って捨てられる
  it("backs up the draft and says so when the note's frontmatter cannot be read", async () => {
    brokenMeta.add(FILE_A);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n壊れたノートに足した行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/保存できません/u));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("壊れたノートに足した行");
    // 断られた書き込みは何も変えない
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });

  // 断られたときに退避するのも、Stale と同じく「飛んでいった写し」ではなく
  // いま画面にある本文。往復のあいだに打った字はファイルにも控えにも無く、
  // 警告を見てそのまま閉じられたらそこで消える
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
    // 次の debounce が届く前に見る。ここが「一回目」なら、閉じた人は二回目を失う
    expect(countOf("update_draft")).toBe(1);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("二回目");
  });

  // 「いま画面にある本文」が打った本人のものだとは限らない。往復のあいだに
  // A → B → A と移ると、選んでいるノートは A に戻っていても、画面の本文は
  // まだ B のまま(A の読み直しが届いていない)。そこで画面のぶんを退避すると、
  // A の控えが B の本文になり、断られた打鍵はどこにも残らない
  it("keeps the refused note's own draft when the selection went away and back", async () => {
    disk.set(FILE_B, BODY_B);
    brokenMeta.add(FILE_A);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n一回目`);

    // 保存が飛んだところで止める。予約はもう消えているので、この先の選択の
    // 差し替えは飛んでいる保存を待ってくれない
    blockWrites();
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    // A へ戻るが、本文は届かない。選択だけが A で、画面にあるのは B の本文
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
    // 画面に出ているのは A の打鍵ではない。名乗って控えの在り処を言う
    expect(shell?.toast()?.message).toContain(TITLE_A);
  });

  // 開いてから消えたノート。core は「作り直す入口ではない」と断るので、
  // 壊れた記録と同じく読み直しても直らない。退避しないと、離れた時点で
  // 打った字がどこにも残らないまま消える
  it("backs up the draft and says so when the note is already gone", async () => {
    await openNoteA();
    await startEditingBody();
    // 打鍵から保存が飛ぶまでのあいだに、別の画面・別の端末がこれを消す
    duringSave = () => disk.delete(FILE_A);
    typeInEditor?.(`${TEXT_A}\n\n消えたノートに足した行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/もう在りません/u));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("消えたノートに足した行");
    // 無いノートは一覧を取り直せば行ごと消える。開き直して「戻す」で呼び出す
    // 道も無いので、呼び出せるとは言わない — 言えば人はそれを信じて閉じる
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(shell?.toast()?.message).toMatch(/写して/u);
  });

  // 開いているノートが、同期や外の道具に文字として読めないバイト列で
  // 置き換えられた。core は読む段で書き込みを断るが、それを一時的な失敗と
  // して黙って捨てると、打った字はディスクにも控えにも残らず、警告も出ない
  // ままそのノートを閉じられる
  it("backs up the draft and says so when the note is no longer text", async () => {
    await openNoteA();
    await startEditingBody();
    // 打鍵から保存が飛ぶまでのあいだに、同期が読めないバイト列を置いていく
    duringSave = () => notText.add(FILE_A);
    typeInEditor?.(`${TEXT_A}\n\n読めなくなったノートに足した行`);

    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/文字として読めない/u));
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain(
      "読めなくなったノートに足した行",
    );
    // 開き直しても本文が読めないので、「戻す」で取り出せるとは言わない
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(shell?.toast()?.message).toMatch(/写して/u);
    // 断られた書き込みは何も変えない
    expect(disk.get(FILE_A)).toBe(BODY_A);
  });

  // 「画面にあるうちに写して」が届くのは、断られたノートが画面に出ている
  // ときだけ。往復のあいだに隣へ移っていると、画面にあるのは別のノートの
  // 本文で、指した先には写すものが無い。名乗って、控えの在り処を言う
  it("names the vanished note instead of pointing at the note now on screen", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n消えたノートに足した行`);

    // 保存が飛んだところで止める。予約は消えているので、この先の選択の
    // 差し替えは飛んでいる保存を待たない
    blockWrites();
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    // 往復のあいだに、別の画面・別の端末が A を消す
    disk.delete(FILE_A);

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    releaseWrites();

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/もう在りません/u), {
      timeout: 3000,
    });
    const message = shell?.toast()?.message;
    // どのノートの話かを名乗る。画面に出ている B の話だと読まれない
    expect(message).toContain(TITLE_A);
    // 画面にも「戻す」にも無いものを指さない
    expect(message).not.toMatch(/画面にあるうち|写して|戻す/u);
    // 控えが端末に在ることは言う。失うより残すほうがよい
    expect(message).toMatch(/この端末に控え/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("消えたノートに足した行");
  });

  // Stale も同じ穴だった。往復のあいだに隣へ移っていると、選択が外れた A は
  // 読み直されないのに「読み直しました。『戻す』で呼び出せます」と言う —
  // 画面にあるのは B なので、B を読み直して B を戻す話に読める。A を名乗り、
  // A を開き直してからだと言う。書けるノートなので取り出す道はある
  it("names the note changed elsewhere instead of pointing at the note now on screen", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n譲る前に打った行`);

    // 保存が飛んだところで止める。予約は消えているので、この先の選択の
    // 差し替えは飛んでいる保存を待たない
    blockWrites();
    await waitFor(() => expect(countOf("update_draft")).toBe(1), { timeout: 3000 });
    // 往復のあいだに、別の画面・別の端末が A を書き換える
    disk.set(FILE_A, BODY_A_SYNCED);

    fireEvent.click(await rowOf(TITLE_B));
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));
    releaseWrites();

    await waitFor(() => expect(shell?.toast()?.message).toContain(TITLE_A), { timeout: 3000 });
    const message = shell?.toast()?.message;
    // 選択が外れた A は読み直していない。読み直したと言えば、人は画面に
    // 出ている B が入れ替わったのだと読む
    expect(message).not.toMatch(/読み直しました/u);
    // 控えは在り、ノートは書ける。開き直してからなら「戻す」で取り出せる
    expect(message).toMatch(/この端末に控え/u);
    expect(message).toMatch(/開き直/u);
    expect(message).toMatch(/戻す/u);
    // 画面は B のまま。A を読み直すのは開き直したときだけ
    expect(titleInput().value).toBe(TITLE_B);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("譲る前に打った行");
  });

  // Stale の言い分は「読み直したか」で変わるのに、読み直す前の状態で決めて
  // いた。読み直しが読めずに引き返すと、画面には打った本文が残っているのに
  // 「読み直しました」と言う — 人はディスクのぶんが出ていると思って写すのを
  // やめる
  it("does not claim a reload that the read never delivered", async () => {
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n譲る前に打った行`);
    duringSave = () => {
      duringSave = undefined;
      // 別の端末が書き換え、そのうえ読み直しも通らない端末
      disk.set(FILE_A, BODY_A_SYNCED);
      readFails = true;
    };

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/別の場所で書き換えられていた/u), {
      timeout: 3000,
    });
    // エディタは作り直されていない。画面にあるのは打った本文のままで、
    // ディスクのぶんは載っていない — 読み直したとは言えない
    expect(screen.getByText(TEXT_A)).toBeDefined();
    expect(screen.queryByText("他の端末で足された行")).toBeNull();
    expect(shell?.toast()?.message).not.toMatch(/読み直しました/u);
    // 控えは在る。画面にあるうちに写せることを言う
    expect(shell?.toast()?.message).toMatch(/この端末に控え/u);
    expect(shell?.toast()?.message).toMatch(/写して/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("譲る前に打った行");
  });

  // 控えも残せず、しかも読み直せなかったとき。画面にはまだ打った本文が
  // 在るのに「失われました」と言うと、人は諦めてそのまま閉じる
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
    // エディタは作り直されていない。画面にはまだ打った本文が在るのだから、
    // 失われたとは言わない
    expect(screen.getByText(TEXT_A)).toBeDefined();
    expect(screen.queryByText("他の端末で足された行")).toBeNull();
    expect(shell?.toast()?.message).not.toMatch(/失われました/u);
  });

  // 読み直しの答えが届く前に隣のノートへ移ると、読み直しは見送られる。
  // 譲る前の「画面に出ていた」で言うと、画面にあるのは別のノートなのに
  // そのノートを指して「読み直しました」と言うことになる
  it("names the note it yielded when the screen moved on during the read", async () => {
    disk.set(FILE_B, BODY_B);
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n譲る前に打った行`);
    duringSave = () => {
      duringSave = undefined;
      disk.set(FILE_A, BODY_A_SYNCED);
      // 譲ったあとの読み直しを止めておく
      blockReads();
    };

    // 読み直しが飛んだところ(開いたときの 1 回 + 譲ったあとの 1 回)
    await waitFor(() => expect(countOf("read_note")).toBe(2), { timeout: 3000 });
    fireEvent.click(await rowOf(TITLE_B));
    releaseReads();
    await waitFor(() => expect(titleInput().value).toBe(TITLE_B));

    await waitFor(() => expect(shell?.toast()?.message).toContain(TITLE_A), { timeout: 3000 });
    // A の読み直しは画面に載っていない。載ったと言えば、人は画面に出ている
    // B が入れ替わったのだと読む
    expect(shell?.toast()?.message).not.toMatch(/読み直しました/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toContain("譲る前に打った行");
  });

  // 退避そのものが失敗する端末(localStorage が満杯・無効)。ディスクへの
  // 保存は既に断られているので、ここで「戻す」で呼び出せると言うと、
  // 人はそれを信じて閉じ、唯一の写しごと失う
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
    // 在りもしない写しを指して「戻す」と言わない
    expect(shell?.toast()?.message).not.toMatch(/戻す/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBeNull();
  });

  // Stale の退避も同じ端末では残らない。そこで「『戻す』で呼び出せます」と
  // 言うと、人はそれを信じて閉じる。読み直しで画面の本文もディスクのぶんに
  // 入れ替わっているので、写す相手ももう無い — 失われたことだけを言う
  it("promises no Revert when a stale save's backup cannot be written", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    onTestFinished(() => setItem.mockRestore());
    await openNoteA();
    await startEditingBody();
    typeInEditor?.(`${TEXT_A}\n\n控えられなかった行`);
    disk.set(FILE_A, BODY_A_SYNCED);

    await waitFor(() => expect(shell?.toast()?.message).toMatch(/失われました/u), {
      timeout: 3000,
    });
    // 読み直しは着いている。画面の本文はディスクのぶんで、打った字はもう無い
    expect(screen.getByText("他の端末で足された行")).toBeDefined();
    expect(shell?.toast()?.message).not.toMatch(/戻す|写して/u);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBeNull();
  });

  // 壊れた記録のノートは「戻す」の書き込みも同じ理由で断る。書けないことを
  // 理由に控えを見せないと、退避は残っているのに取り出す道がどこにも無い
  it("shows the backup on screen when the note it belongs to cannot be written", async () => {
    const typed = `# ${TITLE_A}\n\n壊れたノートで打った行`;
    localStorage.setItem(`note-backup:${FILE_A}`, typed);
    brokenMeta.add(FILE_A);
    await openNoteA();

    await runNoteAction("編集前に戻す");

    // 打った字が実際に画面へ戻る。ここから選んで写せる
    await waitFor(() => expect(screen.getByText("壊れたノートで打った行")).toBeDefined());
    expect(shell?.toast()?.message).toMatch(/ディスクには書けない/u);
    // 断られた書き込みは何も変えない。控えはまだ唯一の写しなので入れ替えない
    expect(disk.get(FILE_A)).toBe(BODY_A);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBe(typed);
  });

  // 文字として読めなくなったノートも「戻す」の書き込みを断る。書けないことを
  // 理由に控えを見せないと、開いているあいだに取り出す最後の道が閉じる —
  // 開き直せば本文ごと読めないので、次の機会はもう無い
  it("shows the backup on screen when the note it belongs to is no longer text", async () => {
    const typed = `# ${TITLE_A}\n\n読めなくなる前に打った行`;
    localStorage.setItem(`note-backup:${FILE_A}`, typed);
    await openNoteA();
    // 開いたあとにファイルが読めないバイト列になった。画面の本文はまだ在る
    notText.add(FILE_A);

    await runNoteAction("編集前に戻す");

    await waitFor(() => expect(screen.getByText("読めなくなる前に打った行")).toBeDefined());
    expect(shell?.toast()?.message).toMatch(/ディスクには書けない/u);
    expect(disk.get(FILE_A)).toBe(BODY_A);
    expect(localStorage.getItem(`note-backup:${FILE_A}`)).toBe(typed);
  });

  // 読み直せば書けるノートでは、控えを画面に出して終わりにしない。画面と
  // ディスクが黙って食い違い、次の保存が相手の本文を控えで潰す
  it("still refuses to revert when the write is turned down as stale", async () => {
    localStorage.setItem(`note-backup:${FILE_A}`, `# ${TITLE_A}\n\n控えの行`);
    await openNoteA();
    // 読んでから押すまでに、別の端末がこれを書き換えた
    disk.set(FILE_A, BODY_A_SYNCED);

    await runNoteAction("編集前に戻す");

    await waitFor(() => expect(shell?.toast()?.message).toBe("戻せませんでした"));
    expect(screen.queryByText("控えの行")).toBeNull();
    expect(disk.get(FILE_A)).toBe(BODY_A_SYNCED);
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

// Codex は同じ画面の別の面。置き場(ディレクトリ)が違うだけで、開いたら
// 書く形は Note と同じ(#255)
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
   * ⌘N が作るのは Note で、押せば Notes へ移る。この面の「新規」は今いる面の
   * ものを作るので、ここに札を出すと、札のとおりに打った人には別の物が別の
   * 場所にできる。キーが無いのではなく、このボタンのキーではない
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

  // ウィジェットや [[リンク]] は ID しか知らないので /notes に着く。相手が
  // Codex なら、その面へ送り直す
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
    // 戻れない操作なので、押した瞬間には動かない
    expect(countOf("promote_note_to_codex")).toBe(0);
    fireEvent.click(await screen.findByRole("button", { name: "Codex にする" }));

    await waitFor(() => expect(kinds.get(FILE_A)).toBe("codex"));
    // 着地したのは Codex の面。同じノートが開いたまま
    await waitFor(() => expect(screen.getByText("Codex")).toBeDefined());
    await rowOf(TITLE_A);
    await waitFor(() => expect(titleInput().value).toBe(TITLE_A));
  });

  // 確認が出た瞬間、焦点は消えたメニューの行に取り残される。矢印キーが辿るのは
  // メニューの行だけで、外へ出ればメニューごと畳まれるので、キーボードだけで
  // 開いた人は戻れない操作を押すことも取り消すこともできなくなる
  it("hands the focus to the confirmation the menu just replaced", async () => {
    await openNoteA();

    await runNoteAction("Codex にする");

    const confirm = await screen.findByRole("button", { name: "Codex にする" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  // 予約が発火済みで書き込みが飛んでいる最中に昇格すると、書き込みは移動前の
  // path に向かい、Codex には古い本文だけが残る。書き終わるまで移さない
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

  // 一覧の行の右端、日付の左に角折りのページ。中の数が版の数で、枠の色が
  // 「動いたか」。Note の行には無い
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

  /** Codex を 1 本開いた状態まで進める。 */
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

  // 版は人が刻む印。保存にも、別のノートへの移動にも掛けない
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

  // 履歴はディスクの本文と版を比べる。画面にしか無い打鍵を残して開くと、
  // 「戻す」がそれを「戻す前」の版にも下書きにも入れずに消してしまう
  it("flushes pending edits before showing history", async () => {
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    await startEditingBody();
    typeInEditor?.(`# ${TITLE_C}\n\n${TEXT_C}\n\n足した行`);
    await runNoteAction("履歴");

    // パネルが開いた時点で、打った字はもうディスクにある
    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());
    expect(writesTo(FILE_C)).toHaveLength(1);
    expect(disk.get(FILE_C)).toContain("足した行");
  });

  // 刻むのはディスクの本文。発火済みで飛んでいる保存を待たないと、最後の
  // 打鍵が入っていない版を「刻めた」と言ってしまう
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

  // 版は他の端末でも刻まれる。同期の読み直しで本文と一覧は新しくなるのに、
  // メタ行の「版 N」だけ古いままでは信用できない
  it("refreshes the version status when data changes elsewhere", async () => {
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    versions.set(FILE_C, [{ id: "v1", message: "別の端末で", body: BODY_C }]);
    shell?.refreshData();

    await waitFor(() => expect(metaLine()?.textContent).toBe("版 1"));
  });

  // Note から Codex に移しても [[ID]] は同じ ID を指し続ける。面で絞った
  // 解決表だと、移した瞬間にリンクの題が消えて補完からも落ちる
  it("resolves [[links]] and offers completion across both surfaces", async () => {
    disk.set(FILE_C, BODY_C);
    kinds.set(FILE_C, "codex");
    renderWorkspace();
    fireEvent.click(await rowOf(TITLE_A));
    await waitFor(() => expect(editorBody().isContentEditable).toBe(true));

    expect(editorBody().dataset.noteLinks?.split(",")).toContain(FILE_C.replace(/\.md$/u, ""));
  });

  // 一言は聞かない。押した瞬間に刻み、トーストで要約を言い、猶予のあいだは
  // 取り消せる — 取り消しは版のファイルを消すだけで、本文には触れない
  it("commits at once without a message and can be undone from the toast", async () => {
    await openCodexC();
    await waitFor(() => expect(metaLine()?.textContent).toBe("版なし"));

    await runNoteAction("版を刻む");

    await waitFor(() => expect(countOf("commit_note_version")).toBe(1));
    expect(calls.find((c) => c.cmd === "commit_note_version")?.args).toStrictEqual({
      filename: FILE_C,
      message: null,
    });
    // 履歴にも点が 1 つ増える(下書きの中空 + 版の塗り)。刻んだばかりの
    // 行は跳ねて入るので、その 1 行だけが印を持つ
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

  // 履歴を開いても本文は消えない。右にパネルが立って最新の版が選ばれ、版との
  // 差は本文の欄外の印になる。エディタは畳み、読むだけの本文になる
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
    // 最新の版は下書きと同じ。印は 1 つも立たず、下書きの行がそう言う
    expect(document.querySelector(".history-row--draft")?.textContent).toContain("同じ内容");
    expect(screen.getByText(TEXT_C)).toBeDefined();
    expect(document.querySelector(".diff-mark")).toBeNull();
    // 選んだ版に戻すボタンは、その行の下にだけ在る
    expect(screen.getByRole("button", { name: "版 2 に戻す" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "版 1 に戻す" })).toBeNull();

    fireEvent.click(await versionRow(1));

    await waitFor(() => {
      expect(document.querySelectorAll(".diff-mark--del").length).toBeGreaterThan(0);
      expect(document.querySelectorAll(".diff-mark--add").length).toBeGreaterThan(0);
    });
    // 開いた瞬間の版 2 との比較が先に走っている。見るのは押した後のほう
    expect(calls.findLast((c) => c.cmd === "diff_note_versions")?.args).toStrictEqual({
      filename: FILE_C,
      from: "v1",
    });
    // 消えた行は選んだ版にしか無い行。下書きの本文に差し込まれて読める
    expect(screen.getByText("最初の一行")).toBeDefined();
    expect(screen.getByText(TEXT_C)).toBeDefined();
    // 何と比べていて何行動いたかはメタ行が言う。行数は既に読んでいる差分から
    // 数えるので、IPC は 1 本も増えない
    await waitFor(() =>
      expect(document.querySelector(".detail-compare-status")?.textContent).toBe(
        "版 1 と比較中 · 3 行追加 · 3 行削除 · 読み取り専用",
      ),
    );

    // Esc で閉じる。パネルは畳まれ、エディタが戻る
    fireEvent.keyDown(globalThis, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
  });

  // 開いた瞬間に選ぶ最新の版は、開くときに読み直した一覧のもの。手元の一覧で
  // 選ぶと、別の端末で刻まれた新しい版があっても 1 つ古いほうが開く
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

  // 履歴のボタンは Codex にだけ在り、同じボタンで開いて畳める。ホバーでは
  // 開かない — 書いている手の横で、通りすがりに 320px が現れてはいけない
  it("opens and folds the panel from the one history button, never on hover", async () => {
    await openCodexC();

    const button = screen.getByRole("button", { name: "履歴" });
    expect(document.querySelector(".history-panel--open")).toBeNull();

    // 乗っただけでは開かない
    fireEvent.pointerEnter(document.querySelector(".history-panel") as HTMLElement);
    await sleep(50);
    expect(document.querySelector(".history-panel--open")).toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // 版が無ければ、次の一手(刻む)がそこにある
    expect(screen.getByText("まだ版がありません。いまの本文が最初の版になります。")).toBeDefined();

    // 同じボタンで畳む。× と Esc も同じところへ着く
    fireEvent.click(button);
    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());

    teardownWorkspace();
    await setupWorkspace();
    await openNoteA();
    expect(document.querySelector(".history-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "履歴" })).toBeNull();
  });

  /**
   * ホバーでは開かないパネルなので、キーの無いあいだ入口はボタン 1 つだけ
   * だった。⌘ を押したときに肩へ札が出る以上、そのキーは効かなければならない。
   */
  it("opens and folds the history from ⌘⇧H", async () => {
    await openCodexC();

    fireEvent.keyDown(editorBody(), { key: "H", metaKey: true, shiftKey: true });

    await waitFor(() => expect(document.querySelector(".history-panel--open")).not.toBeNull());

    fireEvent.keyDown(globalThis, { key: "H", metaKey: true, shiftKey: true });

    await waitFor(() => expect(document.querySelector(".history-panel--open")).toBeNull());
  });

  // ⌘ を押し続けているあいだ肩に浮かぶ札。押せるキーのある入口には出す
  it("wears its key on the shoulder of the history button", async () => {
    await openCodexC();

    expect(screen.getByRole("button", { name: "履歴" }).dataset.hintKey).toBe(
      shortcutLabel("noteHistory"),
    );
  });

  // × は Esc と同じところへ着く。開けた人が閉じ方を探さない
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
    // 読んだときの指紋で書く。外で書き換えられていれば core が断る
    expect(args?.revision).toBe(revisionOf(BODY_C));
    // 戻した本文が画面に出て、履歴は畳まれる
    await waitFor(() => expect(screen.getByText("最初の一行")).toBeDefined());
    expect(document.querySelector(".history-panel--open")).toBeNull();
    // 戻す前の下書きが最新の版になり、戻した本文はそれと違うので距離が出る
    await waitFor(() => expect(metaLine()?.textContent).toMatch(/^版 2 から /u));
  });

  // 戻す書き込みは通ったのに、そのあとの読み直しが画面に届かないことがある。
  // 画面は戻す前の本文なのに指紋だけ戻した後のものになり、そのまま次の打鍵を
  // 保存すると core の照合を素通りして、いま戻した版を黙って潰す
  it("does not claim a restore the screen never received, nor overwrite it on the next save", async () => {
    await openCodexC();
    const OLD_BODY = `# ${TITLE_C}\n\n最初の一行`;
    versions.set(FILE_C, [{ id: "v1", message: "最初の骨組み", body: OLD_BODY }]);

    await runNoteAction("履歴");
    fireEvent.click(await versionRow(1));
    // 戻す書き込みは通るが、そのあとの読み直しでディスクが読めない
    readFails = true;
    fireEvent.click(await screen.findByRole("button", { name: "版 1 に戻す" }));

    await waitFor(() => expect(countOf("restore_note_version")).toBe(1));
    expect(disk.get(FILE_C)).toBe(OLD_BODY);
    // 戻したとは言わない。画面に出せなかったことを言う
    await waitFor(() => expect(shell?.toast()?.message).toMatch(/画面に出せませんでした/u));
    expect(shell?.toast()?.message).not.toMatch(/戻す前の下書きは履歴にあります/u);
    // 画面にあるのは戻す前の本文のまま
    expect(screen.getByText(TEXT_C)).toBeDefined();

    // その本文に書き足しても、いま戻した版は残る
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

  // 携帯にはパネルを立てる幅が無い。履歴はシートではなく本文と入れ替わる
  // 専用の面で、版を押すと本文へ戻って比較モードになる
  it("gives a phone a history screen instead of a panel", async () => {
    await page.viewport(390, 844);
    versions.set(FILE_C, [
      { id: "v2", message: null, body: BODY_C },
      { id: "v1", message: null, body: `# ${TITLE_C}\n\n最初の一行` },
    ]);
    await openCodexC();

    await runNoteAction("履歴");

    await waitFor(() => expect(document.querySelector(".history-panel--screen")).not.toBeNull());
    // 面ごと入れ替わるので本文は残らない。戻すも行の下には出ない — 比較バーが持つ
    expect(screen.queryByTestId("editor-body")).toBeNull();
    expect(document.querySelector(".detail-body")).toBeNull();
    expect(screen.queryByRole("button", { name: "版 2 に戻す" })).toBeNull();

    fireEvent.click(await versionRow(1));

    // 本文へ戻って比較モード。欄外の印が立ち、何と比べているかは下の帯が言う
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
    // 比較中は読み取り専用。メタ行の側には出さない — 帯と二重に言わない
    expect(document.querySelector(".detail-compare-status")).toBeNull();

    // 帯の「履歴」で面へ戻れる
    fireEvent.click(within(bar).getByRole("button", { name: "履歴" }));
    await waitFor(() => expect(document.querySelector(".history-panel--screen")).not.toBeNull());

    // ← で本文へ。比較モードのままなので帯は残る。
    // 読み上げ名で引くのは、この矢印が戻る先を言い当てているかを一緒に見るため
    fireEvent.click(screen.getByLabelText("本文に戻る"));
    await waitFor(() => expect(document.querySelector(".compare-bar")).not.toBeNull());

    // × で比較をやめる。エディタが戻る
    fireEvent.click(document.querySelector(".compare-bar-close") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".compare-bar")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
  });
});
