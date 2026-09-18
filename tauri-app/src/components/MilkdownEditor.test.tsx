import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { describe, it, expect, afterEach } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { getMarkdown } from "@milkdown/kit/utils";
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

/**
 * gfm は `- [ ]` を li の checked 属性に畳む。文字としての `[ ]` は消えるので、
 * 印(CSS)と切り替え(task-item-plugin)が無いと、開いた瞬間に状態が見えなくなる。
 */
function taskItem(container: HTMLElement): HTMLElement {
  const item = container.querySelector<HTMLElement>('.ProseMirror li[data-item-type="task"]');
  if (!item) {
    throw new Error("expected a task item");
  }
  return item;
}

/** その項目の段落。gfm の li は段落を包む */
function itemText(item: HTMLElement): HTMLElement {
  const text = item.querySelector("p");
  if (!text) {
    throw new Error("expected the item's paragraph");
  }
  return text;
}

/** 印は li の内容箱の左に描かれる。そこを押す */
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

  // 文字を押すのはカーソルを置く操作。印の外で状態が変わってはいけない
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

describe("MilkdownEditor Markdown style", () => {
  afterEach(() => cleanup());

  // 書き戻しは手で書いた綴りを保つ。remark-stringify の既定は箇条書きを
  // `* `、罫線を `***`、強調を `_x_` に直すので、1 字直しただけで
  // Codex の版との差分がリスト全行に立っていた
  it("writes lists, rules and emphasis back the way they were written", async () => {
    const source = [
      "- 親",
      "  - 子",
      "",
      "1. 一",
      "2. 二",
      "",
      "- [ ] 用事",
      "",
      "---",
      "",
      "*強め* **強い**",
    ].join("\n");
    const { editor } = await mountPlain(source);

    expect(editor()?.action(getMarkdown())).toBe(`${source}\n`);
  });
});
