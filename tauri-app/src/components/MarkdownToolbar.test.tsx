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

// The real commonmark schema needs the whole editor initialised. All that is
// needed here is whether the caret is in a paragraph or a code block, so build only the shape.
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

/** A document with one paragraph and one code block. The caret goes in the one named. */
function stateWithCursorIn(block: Block): EditorState {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text("plain")),
    schema.nodes.code_block.create(null, schema.text("code")),
  ]);
  // The paragraph occupies 0..7; the content of the code block after it starts at 8
  const pos = block === "paragraph" ? 2 : 9;
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
}

interface MockEditor {
  editor: Editor;
  /** The body's contenteditable. Where the toolbar's handling of focus is observed. */
  body: HTMLElement;
  /** Keys of the commands fired through commandsCtx. */
  fired: unknown[];
  /** Transactions passed to view.dispatch. */
  dispatched: Transaction[];
  /** Pretend the selection moved. Delivered through the same listener path as the real thing. */
  moveCursorTo: (block: Block) => void;
}

/**
 * A fake Editor. Standing up the real one would pull in the editor bundle, so
 * this answers only the slices the toolbar touches: root, view, commands, listener.
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
            // The real createCodeBlockCommand changes only the node type and
            // leaves the selection alone, so the listener hears nothing. That
            // silence is reproduced here
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

/** hidden elements are included because on desktop (with hover) the bar is display: none. */
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
    // Hardest syntax to type first. The last one folds the keyboard once writing is done
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
    // Dropped because they compete for width. The `---` input rule and select-and-delete suffice
    expect(screen.queryByLabelText("区切り線")).toBeNull();
    expect(screen.queryByLabelText("ブロックを削除")).toBeNull();
  });

  it("writes [[ as the character itself, not an icon", () => {
    const mock = createMockEditor();
    render(() => <MarkdownToolbar editor={mock.editor} />);

    const button = screen.getByLabelText("記録へのリンク");
    expect(button.textContent).toBe("[[");

    fireEvent.click(button);

    // The completion panel takes it from there; this only goes as far as typing `[[`
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

  // The moment of a press is the only time the location changes without the
  // selection moving. Waiting on the listener, "exit" would not appear or
  // disappear until the caret moves
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
    // The point is stopping the default pointerdown action. If focus moves to the
    // finger, the characters mid-conversion in the IME are dropped (#102)
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

    // The only way to fold the keyboard is to let go of the body's focus
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
