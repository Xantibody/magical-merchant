import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { describe, it, expect, afterEach } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import { Selection } from "@milkdown/kit/prose/state";
import MilkdownEditor from "./MilkdownEditor";
import type { CaretPoint } from "./MilkdownEditor";

/**
 * Writing can start right where the preview was pressed. The preview and the
 * editor share the same geometry (styles/workspace.test.ts), so building the same
 * body twice in the editor and passing the point measured the first time as the
 * caret position the second time tells the same story.
 *
 * A diagram is drawn asynchronously by its node view. Until it is drawn, the
 * block sits at the height of its source, so in this body, where the source is
 * taller than the diagram, resolving the point without waiting makes a point
 * aimed at the paragraph below the diagram land on the source (the code block)
 * (#168). `%%` is a mermaid comment, so the diagram stays small while only the
 * source grows.
 */
const COMMENTS = Array.from({ length: 12 }, (_, i) => `%% 注釈 ${i}`).join("\n");
const TAIL = "図の下の段落。";

function body(diagram: string): string {
  return ["図の上の段落。", "", "```mermaid", diagram, COMMENTS, "```", "", TAIL].join("\n");
}

const DRAWABLE = body("flowchart LR\n  A --> B");
/** A source that cannot be drawn. The diagram never comes, but the caret must still be placed */
const BROKEN = body("nosuchdiagram LR\n  A --> B");

interface Mounted {
  container: HTMLElement;
  editor: () => Editor | undefined;
}

/** Wait until the diagram settles (it appears, or the failure notice appears), then return */
async function mountEditor(source: string, caret?: CaretPoint): Promise<Mounted> {
  let editor: Editor | undefined;
  const { container } = render(() => (
    <MilkdownEditor
      defaultValue={source}
      caret={caret}
      onEditorReady={(created) => {
        editor = created;
      }}
    />
  ));

  await expect
    .poll(() => container.querySelector(".mermaid-editor-preview") !== null, { timeout: 5000 })
    .toBe(true);

  return { container, editor: () => editor };
}

/** The paragraph with that text. Not the empty paragraph the trailing plugin adds at the end */
function paragraph(container: HTMLElement, text: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".ProseMirror > p")].find(
    (element) => element.textContent === text,
  );
  if (!found) {
    throw new Error(`expected a paragraph reading ${text}`);
  }
  return found;
}

/** A point inside the paragraph that is natural to press */
function pointInside(element: HTMLElement): CaretPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 6, y: rect.top + rect.height / 2, scrollTop: 0 };
}

/** Which block the caret is in now. Its text is the quickest thing for a reader to check */
function caretBlock(editor: Editor | undefined): string | undefined {
  return editor?.action((ctx) => ctx.get(editorViewCtx).state.selection.$head.parent.textContent);
}

describe("MilkdownEditor caret placement", () => {
  afterEach(() => cleanup());

  it.each([
    ["a diagram that draws", DRAWABLE],
    ["a diagram that never draws", BROKEN],
  ])("places the caret in the block the tap was on, below %s", async (_name, source) => {
    const measured = await mountEditor(source);
    const caret = pointInside(paragraph(measured.container, TAIL));
    cleanup();

    const editing = await mountEditor(source, caret);

    await expect.poll(() => caretBlock(editing.editor()), { timeout: 3000 }).toBe(TAIL);
  });
});

/**
 * An editor torn down before it came up does not report itself as present. The
 * host uses onEditorReady as the signal that ProseMirror exists (placing the
 * caret in a promoted note, showing the toolbar on a touch device). Handing over
 * an editor built on a root that is gone sends the caret placement triggered by
 * that signal into nothing.
 */
describe("MilkdownEditor torn down while building", () => {
  afterEach(() => cleanup());

  it("does not report an editor it finished building after being unmounted", async () => {
    const reported: (Editor | undefined)[] = [];
    const { unmount } = render(() => (
      <MilkdownEditor
        defaultValue="畳まれる前の本文"
        onEditorReady={(created) => {
          reported.push(created);
        }}
      />
    ));
    unmount();

    // By the time a second editor taking the same path is up, the first one's create is done too
    const later = await mountEditor(DRAWABLE);
    await expect.poll(() => later.editor(), { timeout: 5000 }).toBeDefined();

    expect(reported).toStrictEqual([undefined]);
  });
});

/**
 * With edit mode gone and the editor always open (#210), any syntax the preview
 * (markdown-it) draws but the editor does not breaks the moment a note opens.
 * CommonMark has no tables or strikethrough; the GFM preset draws both.
 */
const TABLE = ["| 見出し | 値 |", "| --- | --- |", "| a | b |"].join("\n");

function sleep(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** No need to wait for a diagram. Wait only until ProseMirror is up, then return */
async function mountPlain(source: string, onChange?: (markdown: string) => void): Promise<Mounted> {
  let editor: Editor | undefined;
  const { container } = render(() => (
    <MilkdownEditor
      defaultValue={source}
      onChange={onChange}
      onEditorReady={(created) => {
        editor = created;
      }}
    />
  ));

  await expect
    .poll(() => container.querySelector(".ProseMirror") !== null, { timeout: 5000 })
    .toBe(true);

  return { container, editor: () => editor };
}

describe("MilkdownEditor GFM blocks", () => {
  afterEach(() => cleanup());

  it("draws a table as a table, not a paragraph of pipes", async () => {
    const { container } = await mountPlain(TABLE);

    expect(container.querySelectorAll(".ProseMirror table")).toHaveLength(1);
    expect(container.querySelectorAll(".ProseMirror th")).toHaveLength(2);
    expect(container.querySelectorAll(".ProseMirror td")).toHaveLength(2);
  });

  it("draws ~~text~~ struck through", async () => {
    const { container } = await mountPlain("~~消す~~");

    expect(container.querySelector(".ProseMirror del, .ProseMirror s")?.textContent).toBe("消す");
  });

  // On the first edit Milkdown rewrites the whole body through remark (tables get
  // aligned with padding). That happens only on edit; a body merely opened is left alone
  it("does not rewrite the body just by opening it", async () => {
    const changes: string[] = [];
    await mountPlain(TABLE, (markdown) => changes.push(markdown));

    await sleep(100);

    expect(changes).toHaveLength(0);
  });

  it("keeps the table rows as rows when a paragraph outside it is edited", async () => {
    const changes: string[] = [];
    const { editor } = await mountPlain(`${TABLE}\n\n表の下の段落。`, (markdown) =>
      changes.push(markdown),
    );

    editor()?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("x", Selection.atEnd(view.state.doc).from));
    });

    await expect.poll(() => changes.length, { timeout: 3000 }).toBeGreaterThan(0);
    // remark pads the columns to the heading width (accepted as its behaviour).
    // What matters is that the pipes stay as rows and are not escaped into text
    const lines = changes
      .at(-1)
      ?.split("\n")
      .map((line) => line.replaceAll(/\s+/gu, " "));
    expect(lines).toContain("| 見出し | 値 |");
    expect(lines).toContain("| a | b |");
    expect(lines).toContain("表の下の段落。x");
  });
});

/**
 * gfm folds `- [ ]` into the li's checked attribute. The literal `[ ]` disappears,
 * so without the box (CSS) and the toggle (task-item-plugin) the state becomes
 * invisible the moment the note opens.
 */
function taskItem(container: HTMLElement): HTMLElement {
  const item = container.querySelector<HTMLElement>('.ProseMirror li[data-item-type="task"]');
  if (!item) {
    throw new Error("expected a task item");
  }
  return item;
}

/** The item's paragraph. A gfm li wraps a paragraph */
function itemText(item: HTMLElement): HTMLElement {
  const text = item.querySelector("p");
  if (!text) {
    throw new Error("expected the item's paragraph");
  }
  return text;
}

/** The box is drawn to the left of the li's content box. Press there */
function pressBox(item: HTMLElement): void {
  const rect = item.getBoundingClientRect();
  fireEvent.mouseDown(item, { button: 0, clientX: rect.left - 8, clientY: rect.top + 8 });
}

describe("MilkdownEditor task list", () => {
  afterEach(() => cleanup());

  it("keeps the checked state on the item instead of in the text", async () => {
    const { container } = await mountPlain("- [ ] 牛乳\n- [x] パン");

    const items = container.querySelectorAll<HTMLElement>('.ProseMirror li[data-item-type="task"]');
    expect([...items].map((item) => [item.dataset.checked, item.textContent])).toStrictEqual([
      ["false", "牛乳"],
      ["true", "パン"],
    ]);
  });

  it("toggles the item from the box and writes it back as [x]", async () => {
    const changes: string[] = [];
    const { container } = await mountPlain("- [ ] 牛乳", (markdown) => changes.push(markdown));

    pressBox(taskItem(container));

    await expect.poll(() => taskItem(container).dataset.checked).toBe("true");
    await expect.poll(() => changes.at(-1)).toContain("[x] 牛乳");
  });

  // Pressing the text places the caret. The state must not change outside the box
  it("leaves the item alone when its text is pressed", async () => {
    const changes: string[] = [];
    const { container } = await mountPlain("- [ ] 牛乳", (markdown) => changes.push(markdown));
    const text = itemText(taskItem(container));
    const rect = text.getBoundingClientRect();

    fireEvent.mouseDown(text, { button: 0, clientX: rect.left + 4, clientY: rect.top + 8 });

    await sleep(100);
    expect(taskItem(container).dataset.checked).toBe("false");
    expect(changes).toHaveLength(0);
  });
});
