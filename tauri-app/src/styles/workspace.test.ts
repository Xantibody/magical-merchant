import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * プレビューを押すと、その場でエディタに入れ替わる。文字の位置や大きさが
 * 少しでも違うと本文が目に見えてズレ、「押した座標の文字にカーソルを置く」
 * 前提も崩れる。同じ本文を両方の DOM で組み、ブロックごとの幾何を突き合わせる。
 */

/**
 * 同じ本文を、それぞれの面が実際に出す DOM で組む。
 * - コードブロック: プレビューは Shiki が `pre.shiki` として出す
 * - 表: markdown-it は見出し行を `thead` に出し、セルに文字を直に置く。
 *   Milkdown(prosemirror-tables)は `tbody` だけで、見出し行は
 *   `tr[data-is-header]`、セルの中身は段落
 */
function bodyBlocks(surface: "preview" | "editor"): string {
  const preClass = surface === "preview" ? "shiki" : "";
  const table =
    surface === "preview"
      ? "<table><thead><tr><th>見出し</th><th>値</th></tr></thead>" +
        "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>"
      : '<table><tbody><tr data-is-header="true"><th><p>見出し</p></th><th><p>値</p></th></tr>' +
        "<tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>";
  return `
  <p>一段目の本文。</p>
  <h2>見出し</h2>
  <p>二段目の本文。</p>
  <pre class="${preClass}"><code>const a = 1;</code></pre>
  <blockquote><p>引用</p></blockquote>
  ${table}
  <p>結び。</p>`;
}

const BLOCK_SELECTORS = [
  ":scope > p:nth-of-type(1)",
  ":scope > h2",
  ":scope > p:nth-of-type(2)",
  ":scope > pre",
  ":scope > blockquote",
  ":scope > table",
  ":scope > table th:nth-of-type(2)",
  ":scope > table td:nth-of-type(1)",
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

function mountDetail(body: string, view: "editor" | "mindmap" | "preview" = "editor"): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <header class="header">header</header>
      <main class="app-main">
        <div class="workspace workspace--detail">
          <div class="detail-pane">
            <input class="note-title-input" value="タイトル" />
            <div class="detail-body" data-view="${view}">${body}</div>
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

/** getComputedStyle は生きた参照なので、次の DOM を組む前に値を写し取る */
function captionType(target: HTMLElement): Record<string, string> {
  const style = getComputedStyle(target);
  return { fontSize: style.fontSize, color: style.color, marginTop: style.marginTop };
}

function measureBlocks(
  body: string,
  view?: "editor" | "mindmap" | "preview",
): Record<string, Geometry> {
  const detail = mountDetail(body, view);
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
    const previewed = measureBlocks(preview(bodyBlocks("preview")));
    const edited = measureBlocks(editor(bodyBlocks("editor")));

    expect(edited).toStrictEqual(previewed);
  });

  // `view: preview` のノートは MarkdownPreview を読むだけの姿で出す。
  // 押しても書き始まらないので、書けるという合図の I ビームは出さない
  it("gives a read-only note no I-beam", async () => {
    await page.viewport(1280, 800);
    mountDetail(preview(bodyBlocks("preview")), "preview");

    expect(getComputedStyle(element(".markdown-preview")).cursor).toBe("default");
  });

  // mermaid はカーソルが離れている間、エディタでもソースを隠して図だけを見せる。
  // その状態の図と、その次のブロックがプレビューと同じ高さに来ること。
  // `%% caption:` を書いた図はキャプションのぶんだけ背が伸びるので、
  // 片側にしか出さないと図の下の本文がずれる (#168 と同じ壊れ方)
  it.each([
    ["without a caption", ""],
    ["with a caption", '<figcaption class="mermaid-caption">図1 — 同期の流れ</figcaption>'],
  ])("hangs a mermaid figure at the same height in both (%s)", (_name, caption) => {
    const before = "<p>前</p>";
    const after = "<p>後</p>";
    const previewBody = mountDetail(
      preview(
        `${before}<figure class="mermaid-block"><div class="mermaid-figure">${SVG}</div>` +
          `${caption}</figure>${after}`,
      ),
    );
    const previewSvg = geometry(element("svg", previewBody), previewBody);
    const previewAfter = geometry(
      element(":scope > p:nth-of-type(2)", blockRoot(previewBody)),
      previewBody,
    );

    const editorBody = mountDetail(
      editor(
        `${before}<div class="code-block-view has-diagram"><pre><code>graph TD</code></pre>` +
          `<div class="mermaid-editor-preview">${SVG}</div>${caption}</div>${after}`,
      ),
    );
    const editorSvg = geometry(element("svg", editorBody), editorBody);
    const editorAfter = geometry(
      element(":scope > p:nth-of-type(2)", blockRoot(editorBody)),
      editorBody,
    );

    expect(editorSvg).toStrictEqual(previewSvg);
    expect(editorAfter).toStrictEqual(previewAfter);
  });

  // 幾何が一致していても、両側とも素の figcaption のままなら通ってしまう。
  // キャプションの体裁は 2 つの面が共有する 1 枚 (diagram-caption.css) から
  // 来ていること — 片方だけが読み込みに失敗していれば、ここで落ちる
  it("takes the caption's type from the sheet both surfaces share", () => {
    const caption = '<figcaption class="mermaid-caption">図1</figcaption>';
    const previewBody = mountDetail(
      preview(
        `<figure class="mermaid-block"><div class="mermaid-figure">${SVG}</div>${caption}</figure>`,
      ),
    );
    const bodyFontSize = getComputedStyle(previewBody).fontSize;
    const previewType = captionType(element("figcaption", previewBody));

    const editorBody = mountDetail(
      editor(
        `<div class="code-block-view has-diagram"><pre><code>graph TD</code></pre>` +
          `<div class="mermaid-editor-preview">${SVG}</div>${caption}</div>`,
      ),
    );

    expect(previewType.fontSize).not.toBe(bodyFontSize);
    expect(previewType.marginTop).not.toBe("0px");
    expect(captionType(element("figcaption", editorBody))).toStrictEqual(previewType);
  });

  // キャプションを出したぶんだけ、次のブロックは下がっていること。
  // 両側が同じ高さでも 0px なら「両方とも出ていない」で通ってしまう
  it("pushes the block after the diagram down by the caption", () => {
    const figure = (caption: string): string =>
      preview(
        `<figure class="mermaid-block"><div class="mermaid-figure">${SVG}</div>` +
          `${caption}</figure><p>後</p>`,
      );
    const plain = mountDetail(figure(""));
    const plainAfter = geometry(element(":scope > p", blockRoot(plain)), plain).top;

    const captioned = mountDetail(figure('<figcaption class="mermaid-caption">図1</figcaption>'));
    const captionedAfter = geometry(element(":scope > p", blockRoot(captioned)), captioned).top;

    expect(captionedAfter).toBeGreaterThan(plainAfter);
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

describe("note head: the title column follows the body", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mountHead(mapOpen: boolean): { head: HTMLElement; body: HTMLElement } {
    const flag = mapOpen ? "--map" : "";
    document.body.innerHTML = `
      <div class="app">
        <header class="header">header</header>
        <main class="app-main">
          <div class="workspace">
            <div class="list-pane"></div>
            <div class="detail-pane detail-pane${flag}">
              <div class="detail-head"><input class="note-title-input" value="題" /></div>
              <div class="detail-panes detail-panes${flag}">
                <div class="detail-body"><div class="markdown-preview"><p>本文</p></div></div>
                ${mapOpen ? '<aside class="detail-map"></aside>' : ""}
              </div>
            </div>
          </div>
        </main>
      </div>`;
    return { head: element(".detail-head"), body: element(".detail-body") };
  }

  const centerOf = (el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    return round(rect.left + rect.width / 2);
  };

  // マップを右に並べると本文の列は左へ寄る。題だけペイン全幅の中央に残ると、
  // 題と本文の左端が揃わない
  it.each([
    ["without the map", false],
    ["with the map alongside", true],
  ])("centers the head over the body column (%s)", async (_name, mapOpen) => {
    await page.viewport(1280, 800);
    const { head, body } = mountHead(mapOpen);

    expect(centerOf(head)).toBe(centerOf(body));
  });

  // 並べる幅が無いところではマップが本文と入れ替わる。題は再びペイン全幅の中央
  it("centers the head over the whole pane once the map replaces the body", async () => {
    await page.viewport(1000, 800);
    const { head } = mountHead(true);

    expect(centerOf(head)).toBe(centerOf(element(".detail-pane")));
  });
});

/** この `@media` の中で `.list-pane` が本文の上に浮いているか。 */
function floatsTheList(rule: CSSMediaRule): boolean {
  return [...rule.cssRules].some(
    (inner) =>
      inner instanceof CSSStyleRule &&
      inner.selectorText === ".list-pane" &&
      inner.style.position === "absolute",
  );
}

/** `.list-pane` を浮かせている `@media` の条件。無ければ空。 */
function flyoutConditions(): string[] {
  const media = [...document.styleSheets].flatMap((sheet) =>
    [...sheet.cssRules].filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule),
  );
  return media.filter((rule) => floatsTheList(rule)).map((rule) => rule.conditionText);
}

/**
 * 一覧は常設のペインをやめ、本文の上に浮くフライアウトになった。閉じている
 * あいだは場所を取らず、押されもしない — 本文は 48px のレールの右から
 * まるごと始まる。
 */
function mountFlyout(open: boolean): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail"></nav>
      <div class="app-column">
        <main class="app-main">
          <div class="workspace">
            <div class="list-pane ${open ? "list-pane--open" : ""}">
              <div class="list-pane-head"></div>
              <div class="list-scroll"></div>
              <div class="list-pane-foot">⌘\\ で常設</div>
            </div>
            <div class="detail-pane"></div>
          </div>
        </main>
        <div class="bottom-bar"></div>
      </div>
    </div>`;
  return element(".list-pane");
}

describe("the list flyout", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  it("stands 280px wide against the rail, over the body", async () => {
    await page.viewport(1280, 800);
    const pane = mountFlyout(true);

    const rect = pane.getBoundingClientRect();
    const detail = element(".detail-pane").getBoundingClientRect();

    expect(rect.width).toBeCloseTo(280, 0);
    expect(rect.left).toBeCloseTo(48, 0);
    // 本文はフライアウトに押しのけられない。開いても下に続いている
    expect(detail.left).toBeCloseTo(48, 0);
  });

  it("stops above the bottom bar", async () => {
    await page.viewport(1280, 800);
    const pane = mountFlyout(true);

    const bar = element(".bottom-bar").getBoundingClientRect();

    expect(pane.getBoundingClientRect().bottom).toBeCloseTo(bar.top, 0);
  });

  // 閉じているあいだに当たり判定が残ると、本文の左 280px が押せなくなる
  it("is out of the way and out of reach while it is closed", async () => {
    await page.viewport(1280, 800);
    const pane = mountFlyout(false);

    const style = getComputedStyle(pane);

    expect(style.opacity).toBe("0");
    expect(style.pointerEvents).toBe("none");
    expect(style.transform).toBe("matrix(1, 0, 0, 1, -24, 0)");
  });

  it("slides and fades with nothing else", async () => {
    await page.viewport(1280, 800);
    const pane = mountFlyout(true);

    const style = getComputedStyle(pane);

    expect(style.transform).toBe("none");
    expect(style.transitionProperty).toBe("transform, opacity");
    expect(style.transitionDuration).toBe("0.22s, 0.18s");
  });

  /**
   * 狭い画面では一覧は 1 枚の頁。浮かせる相手(本文)が横に無い。
   *
   * 見るのは「流れの中に居ること」で、`static` ではない — 一覧はテンプレの
   * シートを内側に置くので、基底の規則がもとから `relative` を持っている。
   * 浮いているかどうかを言うのは `absolute` かどうか。
   */
  it("goes back to being a full page on a phone", async () => {
    await page.viewport(390, 800);
    const pane = mountFlyout(false);

    const style = getComputedStyle(pane);

    expect(style.position).toBe("relative");
    expect(style.opacity).toBe("1");
    expect(style.transform).toBe("none");
    expect(getComputedStyle(element(".list-pane-foot")).display).toBe("none");
  });

  /**
   * 広くてもホバーの無い端末 — タブレット — では、タップで開いた一覧は指が
   * 離れた時点で畳まれる。開ける手はホバーとピンしか無く、そのピンは一覧の
   * 中にあるので、ノートを開いている人は別のノートへ行けなくなる。
   *
   * headless Chromium は必ず `hover: hover` を名乗るので、その画面を作って
   * 測ることはできない。浮かせる規則が条件の内側に居ることだけを見る
   */
  it("floats the list only where a pointer can hover", () => {
    const conditions = flyoutConditions();

    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toContain("hover: hover");
  });
});
