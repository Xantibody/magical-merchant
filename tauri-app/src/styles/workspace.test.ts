import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { page } from "vitest/browser";

/**
 * Clicking the preview swaps it for the editor in place. If the position or size of a
 * character differs at all, the body visibly shifts and the premise "put the cursor on the
 * character at the clicked point" breaks too. Build the same body in both DOMs and compare
 * the geometry of every block.
 */

/**
 * Build the same body in the DOM each surface actually emits.
 * - Code block: in the preview Shiki emits it as `pre.shiki`
 * - Table: markdown-it puts the header row in `thead` and the text directly in the cell.
 *   Milkdown (prosemirror-tables) has only `tbody`, the header row is
 *   `tr[data-is-header]`, and a cell's contents are paragraphs
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

/** The block container: .markdown-preview for the preview, .ProseMirror for the editor */
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

/** Round away the sub-pixel jitter */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Positions are relative to the top left of the body area */
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

/** getComputedStyle is a live reference, so copy the values out before the next DOM is built */
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
    // These are not in index.css (they load with the lazy view), so import them explicitly
    await import("./workspace.css");
    await import("./editor.css");
    await import("./markdown-preview.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  // The body area's padding changes on mobile (767px and below). Check both widths
  it.each([
    ["mobile", 414, 896],
    ["desktop", 1280, 800],
  ])("keeps every block where the preview drew it (%s)", async (_name, width, height) => {
    await page.viewport(width, height);
    const previewed = measureBlocks(preview(bodyBlocks("preview")));
    const edited = measureBlocks(editor(bodyBlocks("editor")));

    expect(edited).toStrictEqual(previewed);
  });

  // A `view: preview` note is drawn through MarkdownPreview as read-only.
  // Clicking does not start writing, so it shows no I-beam, the signal that it is editable
  it("gives a read-only note no I-beam", async () => {
    await page.viewport(1280, 800);
    mountDetail(preview(bodyBlocks("preview")), "preview");

    expect(getComputedStyle(element(".markdown-preview")).cursor).toBe("default");
  });

  // While the cursor is away, mermaid hides the source in the editor too and shows only the
  // figure. In that state the figure and the block after it must sit at the same height as
  // in the preview. A figure written with `%% caption:` grows taller by the caption, so
  // drawing it on only one side shifts the body under the figure (the same break as #168)
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

  // Matching geometry still passes if both sides are left as a bare figcaption.
  // The caption's type must come from the one sheet the two surfaces share
  // (diagram-caption.css): if only one side failed to load it, this fails
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

  // The next block must move down by exactly the height the caption adds.
  // Equal heights on both sides still pass at 0px, which means "neither one is drawn"
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

  // Open Props' normalize caps p/li/blockquote/headings at a 20-60ch readability measure.
  // A ch is the width of "0", so Japanese wraps at about half that many characters and the
  // right half of the column goes empty. .detail-body sets the column width, so every block
  // must stretch to fill the column
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

  // In both modes it is .detail-body that scrolls. If the editor scrolled itself,
  // .detail-body's padding would become a fixed frame, and the scrollTop at the moment of
  // the click would have to be copied over to another element
  it("scrolls the body itself while editing, not the editor", () => {
    const paragraphs = Array.from({ length: 80 }, (_, i) => `<p>段落 ${i}</p>`).join("");
    const body = mountDetail(editor(paragraphs));
    const milkdown = element(".milkdown-editor", body);

    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(milkdown.scrollHeight).toBeLessThanOrEqual(milkdown.clientHeight + 0.5);
  });

  // Even with a short body the editor fills the area, so clicking the padding starts writing
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

  function mountHead(
    mapOpen: boolean,
    pinned = false,
  ): { head: HTMLElement; title: HTMLElement; text: HTMLElement } {
    const flag = mapOpen ? "--map" : "";
    document.body.innerHTML = `
      <div class="app">
        <header class="header">header</header>
        <main class="app-main">
          <div class="workspace">
            <div class="list-pane"></div>
            <div class="detail-pane detail-pane${flag} ${pinned ? "detail-pane--panel" : ""}">
              <div class="detail-head"><div class="detail-title-row"><input class="note-title-input" value="題" /></div></div>
              <div class="detail-panes detail-panes${flag}">
                <div class="detail-body"><div class="markdown-preview"><p>本文</p></div></div>
                ${mapOpen ? '<aside class="detail-map"></aside>' : ""}
              </div>
              <aside class="note-panel ${pinned ? "note-panel--open note-panel--pinned" : ""}"></aside>
            </div>
          </div>
        </main>
      </div>`;
    return {
      head: element(".detail-head"),
      title: element(".note-title-input"),
      text: element(".markdown-preview"),
    };
  }

  const leftOf = (el: HTMLElement): number => round(el.getBoundingClientRect().left);
  const centerOf = (el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    return round(rect.left + rect.width / 2);
  };

  // Laying the map alongside on the right shifts the body column left. The title starts where
  // the body text starts, whatever stands to the right of it
  it.each([
    ["without the map", false, false],
    ["with the map alongside", true, false],
    ["with the panel docked", false, true],
    ["with the map and the panel", true, true],
  ])("starts the title where the body text starts (%s)", async (_name, mapOpen, pinned) => {
    await page.viewport(1400, 800);
    const { title, text } = mountHead(mapOpen, pinned);

    expect(leftOf(title)).toBe(leftOf(text));
  });

  // Docking the panel must not throw the text you are reading sideways. Where the room to the
  // right of the column covers the panel's 320px, the column does not move at all
  it.each([
    ["without the map", 1440, false],
    ["with the map alongside", 1800, true],
  ])(
    "keeps the body column in place when the panel docks with room to spare (%s)",
    async (_name, width, mapOpen) => {
      await page.viewport(width, 800);
      const before = leftOf(mountHead(mapOpen).text);
      const docked = mountHead(mapOpen, true);

      expect(leftOf(docked.text)).toBe(before);
      expect(docked.text.getBoundingClientRect().width).toBeCloseTo(640, 0);
      expect(leftOf(docked.title)).toBe(leftOf(docked.text));
    },
  );

  // Where that room runs out, the column moves left only as far as it must to end 28px short
  // of the panel, and no further. Re-centring would move it by half the panel, 160px
  it.each([
    ["without the map", 1280, false],
    ["with the map alongside", 1600, true],
  ])(
    "moves the body column only by what the panel cannot take from the margin (%s)",
    async (_name, width, mapOpen) => {
      await page.viewport(width, 800);
      const before = leftOf(mountHead(mapOpen).text);
      const docked = mountHead(mapOpen, true);
      const body = element(".detail-body").getBoundingClientRect();
      const shift = before - leftOf(docked.text);

      expect(shift).toBeGreaterThan(0);
      expect(shift).toBeLessThan(160);
      expect(round(docked.text.getBoundingClientRect().right)).toBe(round(body.right - 28));
      expect(leftOf(docked.title)).toBe(leftOf(docked.text));
    },
  );

  // Cut at the map's edge, a long title would wrap over a column of empty space. It runs on
  // over the map and stops 28px before the right edge
  it("runs the head over the map, stopping 28px short of it", async () => {
    await page.viewport(1400, 800);
    const { head } = mountHead(true);

    const right =
      head.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(head).paddingRight);
    expect(round(right)).toBe(round(element(".detail-map").getBoundingClientRect().right - 28));
  });

  // Where there is no width to stand them side by side, the map replaces the body. The
  // title is centred over the map, which now holds the whole column
  it("centers the head over the map once the map replaces the body", async () => {
    await page.viewport(1000, 800);
    const { head } = mountHead(true);

    expect(centerOf(head)).toBe(centerOf(element(".detail-map")));
  });
});

describe("the note panel", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await import("./note-panel.css");
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    await page.viewport(1280, 800);
  });

  function mountPanel(state: "closed" | "floating" | "docked"): HTMLElement {
    document.body.innerHTML = `
      <div class="app">
        <nav class="rail"></nav>
        <div class="app-column">
          <main class="app-main">
            <div class="workspace">
              <div class="detail-pane ${state === "docked" ? "detail-pane--panel" : ""}">
                <div class="detail-head"></div>
                <div class="detail-panes"><div class="detail-body"></div></div>
                ${state === "docked" ? "" : '<div class="note-panel-edge"></div>'}
                <aside class="note-panel ${state === "closed" ? "" : "note-panel--open"} ${state === "docked" ? "note-panel--pinned" : ""}"></aside>
              </div>
            </div>
          </main>
          <div class="bottom-bar"></div>
        </div>
      </div>`;
    return element(".note-panel");
  }

  // Floating, it lies over the body. The body does not move when it comes and goes
  it("floats 320px over the body without moving it", () => {
    const panel = mountPanel("floating");
    const pane = element(".detail-pane").getBoundingClientRect();

    expect(panel.getBoundingClientRect().width).toBeCloseTo(320, 0);
    expect(panel.getBoundingClientRect().right).toBeCloseTo(pane.right, 0);
    // Only the 8px hot zone is kept clear of the body
    expect(element(".detail-panes").getBoundingClientRect().right).toBeCloseTo(pane.right - 8, 0);
    expect(getComputedStyle(panel).boxShadow).not.toBe("none");
  });

  // Docked, the body column gives it room, and the shadow goes: it is part of the page
  it("takes its width from the body once docked", () => {
    const panel = mountPanel("docked");

    expect(element(".detail-panes").getBoundingClientRect().right).toBeCloseTo(
      panel.getBoundingClientRect().left,
      0,
    );
    expect(getComputedStyle(panel).boxShadow).toBe("none");
  });

  // If the hit area stayed while it is closed, the right 320px of the body could not be pressed
  it("is out of the way and out of reach while it is closed", () => {
    const style = getComputedStyle(mountPanel("closed"));

    expect(style.opacity).toBe("0");
    expect(style.visibility).toBe("hidden");
    expect(style.pointerEvents).toBe("none");
    expect(style.transform).toBe("matrix(1, 0, 0, 1, 24, 0)");
  });

  it("keeps an 8px hot zone at the right edge, under the panel", () => {
    const panel = mountPanel("floating");
    const edge = element(".note-panel-edge");

    expect(edge.getBoundingClientRect().width).toBeCloseTo(8, 0);
    expect(Number(getComputedStyle(edge).zIndex)).toBeLessThan(
      Number(getComputedStyle(panel).zIndex),
    );
  });

  // Its shadow falls under the status line, not over it
  it("stops above the bottom bar, which stands over its shadow", () => {
    const panel = mountPanel("floating");
    const bar = element(".bottom-bar");

    expect(panel.getBoundingClientRect().bottom).toBeCloseTo(bar.getBoundingClientRect().top, 0);
    expect(Number(getComputedStyle(bar).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(panel).zIndex),
    );
  });
});

/** Whether `.list-pane` floats over the body inside this `@media`. */
function floatsTheList(rule: CSSMediaRule): boolean {
  return [...rule.cssRules].some(
    (inner) =>
      inner instanceof CSSStyleRule &&
      inner.selectorText === ".workspace--flyout .list-pane" &&
      inner.style.position === "absolute",
  );
}

/** The conditions of the `@media` rules that float `.list-pane`. Empty if there are none. */
function flyoutConditions(): string[] {
  const media = [...document.styleSheets].flatMap((sheet) =>
    [...sheet.cssRules].filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule),
  );
  return media.filter((rule) => floatsTheList(rule)).map((rule) => rule.conditionText);
}

/**
 * The list is no longer a permanent pane. It is a flyout that floats over the body. While
 * it is closed it takes no space and cannot be clicked, and the body starts in full to the
 * right of the 48px rail.
 */
function mountFlyout(open: boolean, detail = false): HTMLElement {
  document.body.innerHTML = `
    <div class="app">
      <nav class="rail"></nav>
      <div class="app-column">
        <main class="app-main">
          <div class="workspace workspace--flyout ${detail ? "workspace--detail" : ""}">
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
    // The flyout does not push the body aside. It carries on underneath while it is open
    expect(detail.left).toBeCloseTo(48, 0);
  });

  it("stops above the bottom bar", async () => {
    await page.viewport(1280, 800);
    const pane = mountFlyout(true);

    const bar = element(".bottom-bar").getBoundingClientRect();

    expect(pane.getBoundingClientRect().bottom).toBeCloseTo(bar.top, 0);
  });

  // If the hit area stayed while it is closed, the left 280px of the body could not be clicked
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
   * On a narrow screen the list is a page of its own. There is nothing beside it (the body)
   * to float over.
   *
   * What is checked is that it is in the flow, not that it is `static`: the list holds the
   * template's sheet inside it, so the base rule already carries `relative`. What says
   * whether it floats is `absolute`.
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
   * On a wide device with no hover, a tablet, a list opened by a tap folds away the moment
   * the finger leaves. The only ways to open it are hover and the pin, and the pin is inside
   * the list, so someone with a note open can no longer reach another note.
   *
   * headless Chromium always reports `hover: hover`, so that screen cannot be built and
   * measured. Only check that the floating rule sits inside the condition
   */
  it("floats the list only where a pointer can hover", () => {
    const conditions = flyoutConditions();

    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toContain("hover: hover");
  });

  /**
   * On a phone the list and the body are one page each and swap in the same place. Without
   * motion in the swap it cannot be read whether the row that was tapped opened or the
   * screen jumped somewhere else. It rises over 180ms, the same as the history page
   * (`history.css`).
   */
  it("rises when the note takes the page on a phone", async () => {
    await page.viewport(390, 800);
    mountFlyout(false, true);

    const style = getComputedStyle(element(".detail-pane"));

    expect(style.animationName).toBe("mm-rise");
    expect(style.animationDuration).toBe("0.18s");
  });

  // In a wide window the list and the body stand side by side and the pages do not swap
  it("does not rise where the list and the body stand side by side", async () => {
    await page.viewport(1280, 800);
    mountFlyout(false, true);

    expect(getComputedStyle(element(".detail-pane")).animationName).toBe("none");
  });
});
