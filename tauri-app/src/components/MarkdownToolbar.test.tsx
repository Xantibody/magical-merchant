import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Editor } from "@milkdown/kit/core";
import MarkdownToolbar from "./MarkdownToolbar";

function createMockEditor(): Editor {
  return {
    action: vi.fn<(callback: unknown) => unknown>(),
  } as unknown as Editor;
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

  it("renders 6 buttons when editor is provided", () => {
    const editor = createMockEditor();
    render(() => <MarkdownToolbar editor={editor} />);

    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toBeDefined();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(6);

    expect(screen.getByLabelText("Outdent")).toBeDefined();
    expect(screen.getByLabelText("Indent")).toBeDefined();
    expect(screen.getByLabelText("Code block")).toBeDefined();
    expect(screen.getByLabelText("Horizontal rule")).toBeDefined();
    // スマホには Mod-Enter も範囲選択もない。ブロックの脱出と削除は
    // ツールバーだけが入口になる
    expect(screen.getByLabelText("ブロックから抜ける")).toBeDefined();
    expect(screen.getByLabelText("ブロックを削除")).toBeDefined();
  });

  it("hides the bottom tabs only while the toolbar is up", () => {
    const editor = createMockEditor();
    const { unmount } = render(() => <MarkdownToolbar editor={editor} />);

    expect(document.body.classList.contains("md-toolbar-open")).toBe(true);
    unmount();
    expect(document.body.classList.contains("md-toolbar-open")).toBe(false);
  });

  it("calls editor.action when a button is clicked", () => {
    const editor = createMockEditor();
    render(() => <MarkdownToolbar editor={editor} />);

    fireEvent.click(screen.getByLabelText("Outdent"));

    expect(editor.action).toHaveBeenCalledWith(expect.any(Function));
  });

  it("hides toolbar when editor becomes undefined", () => {
    const [editor, setEditor] = createSignal<Editor | undefined>(createMockEditor());
    render(() => <MarkdownToolbar editor={editor()} />);

    expect(screen.getByRole("toolbar")).toBeDefined();

    setEditor(undefined);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
