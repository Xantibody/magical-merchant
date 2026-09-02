import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * プレビューを押すと、その場でエディタに入れ替わる。文字の位置や大きさが
 * 少しでも違うと本文が目に見えてズレ、「押した座標の文字にカーソルを置く」
 * 前提も崩れる。同じ本文を両方の DOM で組み、ブロックごとの幾何を突き合わせる。
 */

/** プレビューのコードブロックは Shiki が `pre.shiki` として出す */
function bodyBlocks(preClass: string): string {
  return `
  <p>一段目の本文。</p>
  <h2>見出し</h2>
  <p>二段目の本文。</p>
  <pre class="${preClass}"><code>const a = 1;</code></pre>
  <blockquote><p>引用</p></blockquote>
  <p>結び。</p>`;
}

const BLOCK_SELECTORS = [
  ":scope > p:nth-of-type(1)",
  ":scope > h2",
  ":scope > p:nth-of-type(2)",
  ":scope > pre",
  ":scope > blockquote",
  ":scope > p:nth-of-type(3)",
];

const SVG = '<svg viewBox="0 0 200 100" width="200" height="100"></svg>';

function preview(blocks: string): string {
  return `<div class="markdown-preview">${blocks}</div>`;
}

function editor(blocks: string): string {
  return `
    <div class="milkdown-editor">
      <div class="milkdown">
        <div class="ProseMirror editor" contenteditable="true">${blocks}</div>
      </div>
    </div>`;
}

function element(selector: string, root: ParentNode = document): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

function mountDetail(body: string): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <header class="header">header</header>
      <main class="app-main">
        <div class="workspace workspace--detail">
          <div class="detail-pane">
            <input class="note-title-input" value="タイトル" />
            <div class="detail-body">${body}</div>
          </div>
        </div>
      </main>
    </div>`;
  return element(".detail-body");
}

/** ブロックの入れ物。プレビューは .markdown-preview、エディタは .ProseMirror */
function blockRoot(body: HTMLElement): HTMLElement {
  return body.querySelector<HTMLElement>(".ProseMirror") ?? element(".markdown-preview", body);
}

interface Geometry {
  left: number;
  width: number;
  top: number;
  fontSize: string;
  lineHeight: string;
  fontStyle: string;
  backgroundColor: string;
}

/** サブピクセルの揺れは丸めて捨てる */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 位置は本文欄の左上からの相対 */
function geometry(target: HTMLElement, body: HTMLElement): Geometry {
  const rect = target.getBoundingClientRect();
  const origin = body.getBoundingClientRect();
  const style = getComputedStyle(target);
  return {
    left: round(rect.left - origin.left),
    width: round(rect.width),
    top: round(rect.top - origin.top),
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    fontStyle: style.fontStyle,
    backgroundColor: style.backgroundColor,
  };
}

function measureBlocks(body: string): Record<string, Geometry> {
  const detail = mountDetail(body);
  const root = blockRoot(detail);
  return Object.fromEntries(
    BLOCK_SELECTORS.map((selector) => [selector, geometry(element(selector, root), detail)]),
  );
}

describe("note body: preview and editor draw the same page", () => {
  beforeAll(async () => {
    await import("../index.css");
    // これらは index.css に無い(遅延ビューと一緒に読まれる)ので明示する
    await import("./workspace.css");
    await import("./editor.css");
    await import("./markdown-preview.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // 本文欄の余白はモバイル(767px 以下)で変わる。両方の幅で見る
  it.each([
    ["mobile", 414, 896],
    ["desktop", 1280, 800],
  ])("keeps every block where the preview drew it (%s)", async (_name, width, height) => {
    await page.viewport(width, height);
    const previewed = measureBlocks(preview(bodyBlocks("shiki")));
    const edited = measureBlocks(editor(bodyBlocks("")));

    expect(edited).toEqual(previewed);
  });

  // mermaid はカーソルが離れている間、エディタでもソースを隠して図だけを見せる。
  // その状態の図と、その次のブロックがプレビューと同じ高さに来ること
  it("hangs a mermaid figure at the same height in both", () => {
    const before = "<p>前</p>";
    const after = "<p>後</p>";
    const previewBody = mountDetail(
      preview(`${before}<div class="mermaid-block">${SVG}</div>${after}`),
    );
    const previewSvg = geometry(element("svg", previewBody), previewBody);
    const previewAfter = geometry(
      element(":scope > p:nth-of-type(2)", blockRoot(previewBody)),
      previewBody,
    );

    const editorBody = mountDetail(
      editor(
        `${before}<div class="code-block-view has-diagram"><pre><code>graph TD</code></pre>` +
          `<div class="mermaid-editor-preview">${SVG}</div></div>${after}`,
      ),
    );
    const editorSvg = geometry(element("svg", editorBody), editorBody);
    const editorAfter = geometry(
      element(":scope > p:nth-of-type(2)", blockRoot(editorBody)),
      editorBody,
    );

    expect(editorSvg).toEqual(previewSvg);
    expect(editorAfter).toEqual(previewAfter);
  });

  // Open Props の normalize は p/li/blockquote/見出しに 20〜60ch の読みやすさ上限を
  // 掛ける。ch は「0」の幅なので日本語では半分ほどの文字数で折り返され、段の
  // 右半分が空く。段幅は .detail-body が決めるので、どのブロックも段いっぱいに伸びること
  it.each([
    ["preview", preview],
    ["editor", editor],
  ])("lets every block fill the column, not a ch-based measure (%s)", async (_name, wrap) => {
    await page.viewport(1280, 800);
    const long =
      "日本語の本文は一文字が二桁ぶんの幅を持つので、桁で決めた上限幅ではすぐに折り返してしまう。";
    const body = mountDetail(
      wrap(
        `<h2>${long}</h2><p>${long}</p><blockquote><p>${long}</p></blockquote><ul><li>${long}</li></ul>`,
      ),
    );
    const root = blockRoot(body);
    const column = root.getBoundingClientRect().width;
    const quote = element(":scope > blockquote", root);
    const quoteStyle = getComputedStyle(quote);
    const quoteInner =
      column -
      Number.parseFloat(quoteStyle.borderLeftWidth) -
      Number.parseFloat(quoteStyle.paddingLeft) -
      Number.parseFloat(quoteStyle.paddingRight);
    const list = element(":scope > ul", root);
    const listInner = column - Number.parseFloat(getComputedStyle(list).paddingLeft);

    expect(element(":scope > h2", root).getBoundingClientRect().width).toBeCloseTo(column, 0);
    expect(element(":scope > p", root).getBoundingClientRect().width).toBeCloseTo(column, 0);
    expect(quote.getBoundingClientRect().width).toBeCloseTo(column, 0);
    expect(element("blockquote > p", root).getBoundingClientRect().width).toBeCloseTo(
      quoteInner,
      0,
    );
    expect(element("li", root).getBoundingClientRect().width).toBeCloseTo(listInner, 0);
  });

  // スクロールするのは両モードとも .detail-body。エディタが自分で
  // スクロールすると .detail-body の余白が固定の額縁になり、押した瞬間の
  // scrollTop を別の要素に写し替える必要が生まれる
  it("scrolls the body itself while editing, not the editor", () => {
    const paragraphs = Array.from({ length: 80 }, (_, i) => `<p>段落 ${i}</p>`).join("");
    const body = mountDetail(editor(paragraphs));
    const milkdown = element(".milkdown-editor", body);

    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(milkdown.scrollHeight).toBeLessThanOrEqual(milkdown.clientHeight + 0.5);
  });

  // 短い本文でも、余白を押せば書き始められるようエディタは欄いっぱいに伸びる
  it("stretches a short editor to the bottom of the body", () => {
    const body = mountDetail(editor("<p>一行だけ</p>"));
    const style = getComputedStyle(body);
    const inner =
      body.clientHeight -
      Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom);

    expect(element(".ProseMirror", body).getBoundingClientRect().height).toBeGreaterThanOrEqual(
      inner - 0.5,
    );
  });
});
