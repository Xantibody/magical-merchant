import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import MilkdownEditor from "./MilkdownEditor";
import type { CaretPoint } from "./MilkdownEditor";

/**
 * プレビューを押した場所からそのまま書き始められること。プレビューとエディタの
 * 幾何は揃えてある(styles/workspace.test.ts)ので、同じ本文をエディタで 2 回組み、
 * 1 回目に測った座標を 2 回目のカーソル位置として渡せば同じ話になる。
 *
 * 図は node view が非同期に描く。描き上がるまでブロックはソースの高さで並ぶので、
 * ソースが図より背が高いこの本文では、待たずに座標を引くと図の下の段落を狙った
 * 座標がソース(コードブロック)を指す (#168)。`%%` は mermaid のコメントなので、
 * 図は小さいままソースだけが伸びる。
 */
const COMMENTS = Array.from({ length: 12 }, (_, i) => `%% 注釈 ${i}`).join("\n");
const TAIL = "図の下の段落。";

function body(diagram: string): string {
  return ["図の上の段落。", "", "```mermaid", diagram, COMMENTS, "```", "", TAIL].join("\n");
}

const DRAWABLE = body("flowchart LR\n  A --> B");
/** 描けないソース。図は永遠に来ないが、カーソルは置かれなければならない */
const BROKEN = body("nosuchdiagram LR\n  A --> B");

interface Mounted {
  container: HTMLElement;
  editor: () => Editor | undefined;
}

/** 図の描画が決着する(図が出る/描けなかったと知らせが出る)まで待って返す */
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

/** その文字を持つ段落。trailing プラグインが足す末尾の空段落と取り違えない */
function paragraph(container: HTMLElement, text: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".ProseMirror > p")].find(
    (element) => element.textContent === text,
  );
  if (!found) {
    throw new Error(`expected a paragraph reading ${text}`);
  }
  return found;
}

/** 段落の中の、押しても不自然でない一点 */
function pointInside(element: HTMLElement): CaretPoint {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 6, y: rect.top + rect.height / 2, scrollTop: 0 };
}

/** カーソルが今どのブロックにいるか。文字で見るのが読み手には一番早い */
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
