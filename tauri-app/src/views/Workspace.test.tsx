import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useNavigate } from "@solidjs/router";
import type { JSX } from "solid-js";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import Workspace from "./Workspace";

// 本物の Milkdown は ProseMirror 一式を連れてくる。ここで見たいのは
// 「どのノートに何を書くか」という判断だけなので、開いているという事実と
// 打鍵の入り口だけを持つ板に差し替える
let typeInEditor: ((markdown: string) => void) | undefined;
vi.mock(import("../components/MilkdownEditor"), () => ({
  default: (props: {
    defaultValue?: string;
    onChange?: (markdown: string) => void;
  }): JSX.Element => {
    typeInEditor = props.onChange;
    const el = document.createElement("div");
    el.dataset.testid = "editor-body";
    el.textContent = props.defaultValue ?? "";
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
/** 呼ばれたコマンドと引数。どのノートに何が書かれたかをこれで見る。 */
let calls: { cmd: string; args: Record<string, unknown> }[];
/** read_note を止めておく関門。応答が届く前の操作を再現する。 */
let readGate: Promise<void> | undefined;
let openGate: (() => void) | undefined;
/** update_draft が飛んでいる間に起きること。往復の途中の打鍵を再現する。 */
let duringSave: (() => void) | undefined;

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
  tags: [],
  preview: disk.get(filename) ?? "",
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
    tags: [],
  }),
  create_draft: () => {
    disk.set(FILE_B, "");
    return `/data/notes/${FILE_B}`;
  },
  update_draft: ({ filePath, body, revision }) => {
    duringSave?.();
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
  set_note_view: () => null,
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

/** ノート A を 1 件開いた状態まで進める。狭い画面では詳細を開くまで本文が出ない。 */
async function openNoteA(): Promise<void> {
  render(() => (
    <ShellProvider>
      <CaptureShell />
      <MemoryRouter>
        <Route path="/" component={WorkspaceRoute} />
      </MemoryRouter>
    </ShellProvider>
  ));
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(TITLE_A, "u") }));
  await waitFor(() => expect(screen.getByText(TEXT_A)).toBeDefined());
}

function titleInput(): HTMLInputElement {
  return screen.getByPlaceholderText<HTMLInputElement>("タイトル");
}

/** タイトル欄の Enter が編集の入り口。エディタは lazy なので届くまで待つ。 */
async function startEditingBody(): Promise<void> {
  fireEvent.keyDown(titleInput(), { key: "Enter" });
  await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
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

/** ディスク・IPC・画面の幅を、テスト 1 本ぶんの初期状態に戻す。 */
async function setupWorkspace(): Promise<void> {
  // 一覧と詳細が並ぶ幅。編集中に「+ 新規」を押せるのはこの形のときだけで、
  // 携帯の幅では一覧ペインごと隠れている
  await page.viewport(1280, 800);
  disk = new Map([[FILE_A, BODY_A]]);
  calls = [];
  shell = undefined;
  navigateTo = undefined;
  typeInEditor = undefined;
  duringSave = undefined;
  releaseReads();
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
  // 止めたままの読みを解いてから畳む。待ち続ける promise を残さない
  releaseReads();
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

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
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    fireEvent.change(titleInput(), { target: { value: TITLE_A } });

    // 打った字は消すノートに着地する。隣のノートには何も書かない
    await waitFor(() => expect(disk.get(FILE_A)).toContain("もう一行"), { timeout: 3000 });
    expect(writesTo(FILE_B)).toStrictEqual([]);

    // 5 秒後の本削除はテストの外まで生き残る。UI の「元に戻す」と同じ道で畳む
    await waitFor(() => expect(shell?.toast()?.undo).toBeInstanceOf(Function));
    shell?.toast()?.undo?.();
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
});
