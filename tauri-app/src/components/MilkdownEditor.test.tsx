import { render, cleanup } from "@solidjs/testing-library";
import { describe, it, expect, afterEach } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import type { Editor } from "@milkdown/kit/core";
import { Selection } from "@milkdown/kit/prose/state";
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

/**
 * 立ち上がる前に畳まれたエディタは「居る」と言わない。置く側は onEditorReady を
 * 「ProseMirror がもうある」の合図に使う(昇格したノートにカーソルを置く、
 * タッチ端末のツールバーを出す)。消えた root に立ったエディタを渡すと、
 * その合図で置きに行ったカーソルが空を切る。
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

    // 同じ道を後から通る 2 本目が立つころには、1 本目の create も済んでいる
    const later = await mountEditor(DRAWABLE);
    await expect.poll(() => later.editor(), { timeout: 5000 }).toBeDefined();

    expect(reported).toStrictEqual([undefined]);
  });
});

/**
 * 編集モードを無くしてエディタが常時出るようになった(#210)ので、プレビュー
 * (markdown-it)が描けてエディタが描けない記法は、ノートを開いた瞬間から崩れる。
 * CommonMark に表と取り消し線は無い — GFM のプリセットで両方を描く。
 */
const TABLE = ["| 見出し | 値 |", "| --- | --- |", "| a | b |"].join("\n");

function sleep(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 図の待ちは要らない。ProseMirror が立つまでだけ待って返す */
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

  // Milkdown は最初の編集で本文全体を remark で書き直す(表はパディングで揃う)。
  // それは編集のときだけで、開いただけの本文には触らないこと
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
    // remark は列幅を見出しに揃えてパディングする(仕様として受け入れる)。
    // 見るのは、パイプが文字として逃げずに行のまま残っていること
    const lines = changes
      .at(-1)
      ?.split("\n")
      .map((line) => line.replaceAll(/\s+/gu, " "));
    expect(lines).toContain("| 見出し | 値 |");
    expect(lines).toContain("| a | b |");
    expect(lines).toContain("表の下の段落。x");
  });
});
