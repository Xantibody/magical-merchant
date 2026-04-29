import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { Editor } from "@milkdown/kit/core";
import MarkdownToolbar from "./MarkdownToolbar";

function createMockEditor(): Editor {
  return {
    action: vi.fn(),
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

  it("renders 4 buttons when editor is provided", () => {
    const editor = createMockEditor();
    render(() => <MarkdownToolbar editor={editor} />);

    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toBeDefined();

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);

    expect(screen.getByLabelText("Outdent")).toBeDefined();
    expect(screen.getByLabelText("Indent")).toBeDefined();
    expect(screen.getByLabelText("Code block")).toBeDefined();
    expect(screen.getByLabelText("Horizontal rule")).toBeDefined();
  });

  it("calls editor.action when a button is clicked", () => {
    const editor = createMockEditor();
    render(() => <MarkdownToolbar editor={editor} />);

    fireEvent.click(screen.getByLabelText("Outdent"));

    expect(editor.action).toHaveBeenCalled();
  });

  it("hides toolbar when editor becomes undefined", () => {
    const [editor, setEditor] = createSignal<Editor | undefined>(createMockEditor());
    render(() => <MarkdownToolbar editor={editor()} />);

    expect(screen.getByRole("toolbar")).toBeDefined();

    setEditor(undefined);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
