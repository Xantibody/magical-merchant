import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { MemoryRouter, Route } from "@solidjs/router";
import type { JSX } from "solid-js";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import Workspace from "./Workspace";

// 本物の Milkdown は ProseMirror 一式を連れてくる。ここで見たいのは
// 「編集中に本文を読み直さない」という判断だけなので、開いているという
// 事実だけを持つ板に差し替える
vi.mock(import("../components/MilkdownEditor"), () => ({
  default: (props: { defaultValue?: string }): JSX.Element => {
    const el = document.createElement("div");
    el.dataset.testid = "editor-body";
    el.textContent = props.defaultValue ?? "";
    return el;
  },
}));

const FILENAME = "20260903_120000.md";
const BODY_BEFORE = "# 会議メモ\n\nここまで書いた";
const BODY_AFTER = "# 会議メモ (同期後)\n\n他の端末で足された行";

/** ディスクの中身。テストの途中で外から書き換わったことにする。 */
let diskBody: string;
/** 呼ばれた Tauri コマンドの記録。読み直し経路が何も書かないことを見る。 */
let calls: string[];

const WRITE_COMMANDS = ["update_draft", "create_draft", "set_note_view", "delete_note"];

const countOf = (command: string): number => calls.filter((c) => c === command).length;

const HANDLERS: Record<string, () => unknown> = {
  list_notes: () => [
    {
      path: `/data/notes/${FILENAME}`,
      filename: FILENAME,
      time: "2026-09-03T12:00:00+09:00",
      tags: [],
      preview: diskBody,
    },
  ],
  list_templates: () => [],
  find_backlinks: () => [],
  read_note: () => ({ body: diskBody, revision: `rev-${diskBody.length}` }),
  read_note_meta: () => ({}),
};

let shell: Shell | undefined;

function CaptureShell(): JSX.Element {
  shell = useShell();
  return null;
}

/** ノートを 1 件開いた状態まで進める。狭い画面では詳細を開くまで本文が出ない。 */
async function renderWorkspace(): Promise<void> {
  render(() => (
    <ShellProvider>
      <CaptureShell />
      <MemoryRouter>
        <Route path="/" component={Workspace} />
      </MemoryRouter>
    </ShellProvider>
  ));
  fireEvent.click(await screen.findByRole("button", { name: /会議メモ/u }));
  await waitFor(() => expect(screen.getByText("ここまで書いた")).toBeDefined());
}

function titleInput(): HTMLInputElement {
  return screen.getByPlaceholderText<HTMLInputElement>("タイトル");
}

describe("Workspace › 外から書き換わったノートの読み直し", () => {
  beforeEach(() => {
    diskBody = BODY_BEFORE;
    calls = [];
    shell = undefined;
    mockWindows("main");
    mockIPC((cmd) => {
      calls.push(cmd);
      const handler = HANDLERS[cmd];
      if (!handler) {
        throw new Error(`unexpected command ${cmd}`);
      }
      return handler();
    });
  });

  afterEach(() => {
    cleanup();
    clearMocks();
    document.body.innerHTML = "";
  });

  // 同期でダウンロードされた変更が、開いたままのノートに届く
  it("reloads the open note when dataVersion increases", async () => {
    await renderWorkspace();
    expect(titleInput().value).toBe("会議メモ");

    diskBody = BODY_AFTER;
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
    await renderWorkspace();
    fireEvent.keyDown(titleInput(), { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("editor-body")).toBeDefined());
    const readsBefore = countOf("read_note");

    diskBody = BODY_AFTER;
    shell?.refreshData();

    // 一覧の読み直しが届くまで待つ。そのうえで本文だけが読み直されないことを見る
    await screen.findByText("会議メモ (同期後)");
    expect(countOf("read_note")).toBe(readsBefore);
    expect(screen.getByTestId("editor-body").textContent).toBe("ここまで書いた");
    for (const command of WRITE_COMMANDS) {
      expect(countOf(command)).toBe(0);
    }
  });
});
