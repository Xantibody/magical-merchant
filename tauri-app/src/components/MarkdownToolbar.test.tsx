import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { commandsCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { listenerCtx } from "@milkdown/kit/plugin/listener";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import type { Editor } from "@milkdown/kit/core";
import type { Selection, Transaction } from "@milkdown/kit/prose/state";
import MarkdownToolbar from "./MarkdownToolbar";

// 本物の commonmark スキーマはエディタの初期化ごと必要になる。ここで要るのは
// 「カーソルが段落かコードブロックのどちらにいるか」だけなので形だけ作る。
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    code_block: { group: "block", content: "text*", code: true },
    bullet_list: { group: "block", content: "list_item+" },
    list_item: { content: "paragraph block*" },
    text: {},
  },
});

type Block = "paragraph" | "code_block";

/** 段落とコードブロックが 1 つずつある文書。カーソルは指した側に置く。 */
function stateWithCursorIn(block: Block): EditorState {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text("plain")),
    schema.nodes.code_block.create(null, schema.text("code")),
  ]);
  // 段落は 0..7 を占め、続くコードブロックの中身は 8 から
  const pos = block === "paragraph" ? 2 : 9;
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

interface MockEditor {
  editor: Editor;
  /** 本文の contenteditable。書式バーがフォーカスをどう扱うかをここで見る。 */
  body: HTMLElement;
  /** commandsCtx 経由で撃たれたコマンドのキー。 */
  fired: unknown[];
  /** view.dispatch に渡った transaction。 */
  dispatched: Transaction[];
  /** 選択が動いたことにする。本物と同じ listener の経路で伝える。 */
  moveCursorTo: (block: Block) => void;
}

/**
 * 作りものの Editor。本物を立てるとエディタのバンドルまで要るので、書式バーが
 * 触る slice — root / view / commands / listener — だけを答える。
 */
function createMockEditor(
  options: { cursorIn?: Block; commandRetypesTo?: Block } = {},
): MockEditor {
  const root = document.createElement("div");
  const body = document.createElement("div");
  body.className = "ProseMirror";
  body.contentEditable = "true";
  root.append(body);
  document.body.append(root);

  const fired: unknown[] = [];
  const dispatched: Transaction[] = [];
  const selectionListeners: ((ctx: unknown, selection: Selection) => void)[] = [];
  const view = {
    state: stateWithCursorIn(options.cursorIn ?? "paragraph"),
    dispatch: (tr: Transaction) => dispatched.push(tr),
    dom: body,
  };
  const ctx = {
    get: (slice: unknown) => {
      if (slice === rootCtx) {
        return root;
      }
      if (slice === editorViewCtx) {
        return view;
      }
      if (slice === commandsCtx) {
        return {
          call: (key: unknown) => {
            fired.push(key);
            // 本物の createCodeBlockCommand は節の種類だけを変えて選択を動かさ
            // ないので、listener には何も伝わらない。その黙り方をここで再現する
            if (options.commandRetypesTo) {
              view.state = stateWithCursorIn(options.commandRetypesTo);
            }
          },
        };
      }
      if (slice === listenerCtx) {
        return {
          selectionUpdated: (fn: (ctx: unknown, selection: Selection) => void) =>
            selectionListeners.push(fn),
        };
      }
      throw new Error("unexpected ctx slice");
    },
  };
  const editor = {
    action: vi.fn<(run: (ctx: unknown) => unknown) => unknown>((run) => run(ctx)),
  } as unknown as Editor;

  return {
    editor,
    body,
    fired,
    dispatched,
    moveCursorTo: (block) => {
      view.state = stateWithCursorIn(block);
      for (const fn of selectionListeners) {
        fn(ctx, view.state.selection);
      }
    },
  };
}

/** hidden も対象にするのは、デスクトップ (hover あり) では display: none だから。 */
function labels(): (string | null)[] {
  return screen
    .getAllByRole("button", { hidden: true })
    .map((button) => button.getAttribute("aria-label"));
}

describe("MarkdownToolbar", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("does not render when editor is undefined", () => {
    render(() => <MarkdownToolbar editor={undefined} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("shows seven formatting buttons and the one that closes the keyboard", () => {
    const { editor } = createMockEditor();
    render(() => <MarkdownToolbar editor={editor} />);

    expect(screen.getByRole("toolbar", { hidden: true })).toBeDefined();
    // 打ちにくい記法から順に。最後は書き終わってキーボードを畳むためのもの
    expect(labels()).toStrictEqual([
      "箇条書き",
      "番号付きリスト",
      "チェックリスト",
      "インデントを戻す",
      "インデント",
      "記録へのリンク",
      "コードブロック",
      "キーボードを閉じる",
    ]);
    // 幅を取り合うので落としたもの。`---` の入力ルールと選択削除で足りる
    expect(screen.queryByLabelText("区切り線")).toBeNull();
    expect(screen.queryByLabelText("ブロックを削除")).toBeNull();
  });

  it("writes [[ as the character itself, not an icon", () => {
    const mock = createMockEditor();
    render(() => <MarkdownToolbar editor={mock.editor} />);

    const button = screen.getByLabelText("記録へのリンク");
    expect(button.textContent).toBe("[[");

    fireEvent.click(button);

    // 続きは補完の板が受けるので、ここは `[[` を打つところまで
    expect(mock.dispatched).toHaveLength(1);
    expect(mock.dispatched[0].doc.textContent).toContain("[[");
  });

  it("offers the way out of a code block only from inside one", () => {
    const mock = createMockEditor({ cursorIn: "paragraph" });
    render(() => <MarkdownToolbar editor={mock.editor} />);

    expect(screen.queryByLabelText("ブロックから抜ける")).toBeNull();

    mock.moveCursorTo("code_block");
    expect(screen.getByLabelText("ブロックから抜ける")).toBeDefined();
    expect(labels()).toHaveLength(9);

    mock.moveCursorTo("paragraph");
    expect(screen.queryByLabelText("ブロックから抜ける")).toBeNull();
  });

  // 押した瞬間は、選択が動かないまま居場所が変わる唯一のとき。listener を
  // 待っていると「抜ける」がカーソルを動かすまで出ない・消えない
  it("offers the way out as soon as a press makes the block a code block", () => {
    const mock = createMockEditor({ cursorIn: "paragraph", commandRetypesTo: "code_block" });
    render(() => <MarkdownToolbar editor={mock.editor} />);

    expect(screen.queryByLabelText("ブロックから抜ける")).toBeNull();

    fireEvent.click(screen.getByLabelText("コードブロック"));

    expect(screen.getByLabelText("ブロックから抜ける")).toBeDefined();
  });

  it("takes it away again when a press turns the code block back into a paragraph", () => {
    const mock = createMockEditor({ cursorIn: "code_block", commandRetypesTo: "paragraph" });
    render(() => <MarkdownToolbar editor={mock.editor} />);

    expect(screen.getByLabelText("ブロックから抜ける")).toBeDefined();

    fireEvent.click(screen.getByLabelText("コードブロック"));

    expect(screen.queryByLabelText("ブロックから抜ける")).toBeNull();
  });

  it("offers it from the moment the bar opens inside a code block", () => {
    const mock = createMockEditor({ cursorIn: "code_block" });
    render(() => <MarkdownToolbar editor={mock.editor} />);

    expect(screen.getByLabelText("ブロックから抜ける")).toBeDefined();
  });

  it("never takes the focus off the body", () => {
    const mock = createMockEditor();
    render(() => <MarkdownToolbar editor={mock.editor} />);
    mock.body.focus();

    const button = screen.getByLabelText("インデント");
    // 押し下げの既定動作を止めるのが要点。指にフォーカスが移ると IME の
    // 変換中の文字が落ちる (#102)
    expect(fireEvent.pointerDown(button)).toBe(false);
    fireEvent.click(button);

    expect(mock.fired).toHaveLength(1);
    expect(document.activeElement).toBe(mock.body);
  });

  it("lets the body go when asked to close the keyboard", () => {
    const mock = createMockEditor();
    render(() => <MarkdownToolbar editor={mock.editor} />);
    mock.body.focus();

    fireEvent.click(screen.getByLabelText("キーボードを閉じる"));

    // キーボードを畳む手立ては、本文のフォーカスを放すことしかない
    expect(document.activeElement).not.toBe(mock.body);
  });

  it("hides the bottom tabs only while the toolbar is up", () => {
    const { editor } = createMockEditor();
    const { unmount } = render(() => <MarkdownToolbar editor={editor} />);

    expect(document.body.classList.contains("md-toolbar-open")).toBe(true);
    unmount();
    expect(document.body.classList.contains("md-toolbar-open")).toBe(false);
  });

  it("hides toolbar when editor becomes undefined", () => {
    const [editor, setEditor] = createSignal<Editor | undefined>(createMockEditor().editor);
    render(() => <MarkdownToolbar editor={editor()} />);

    expect(screen.getByRole("toolbar", { hidden: true })).toBeDefined();

    setEditor(undefined);
    expect(screen.queryByRole("toolbar", { hidden: true })).toBeNull();
  });
});
