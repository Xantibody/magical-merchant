import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { renderDiffBlock } from "../lib/diff-block";

/**
 * A diff row says whether it was added or removed through its background. If the row's
 * colour stops at the width of the code and does not reach the pre's padding, the coloured
 * band floats inside the block and it can no longer be read where one row ends.
 */
function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) {
    throw new Error(`expected ${selector} to be mounted`);
  }
  return found;
}

function mountDiff(code: string): void {
  document.body.innerHTML = `
    <div class="detail-pane">
      <div class="detail-body">
        <div class="markdown-preview">${renderDiffBlock(code)}</div>
      </div>
    </div>`;
}

describe("diff rows in the preview", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await import("./markdown-preview.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  it("bleeds the row background out to both edges of the code block", () => {
    mountDiff("+added\n");

    const row = element(".diff-add").getBoundingClientRect();
    const pre = element("pre").getBoundingClientRect();

    expect(row.width).toBeCloseTo(pre.width, 0);
    expect(row.left).toBeCloseTo(pre.left, 0);
  });

  // If a `color-mix` operand is missing, the background falls through as transparent
  it("tints the row from the status tokens", () => {
    mountDiff("+added\n-removed\n");

    expect(getComputedStyle(element(".diff-add")).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(element(".diff-del")).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  // `color-mix` is used so that one declaration gives a strength suited to both the light
  // and the dark ground. Back at a fixed colour, green and red float on the dark theme's black
  it("follows the theme without a second rule", () => {
    mountDiff("+added\n");
    const light = getComputedStyle(element(".diff-add")).backgroundColor;

    document.documentElement.dataset.theme = "dark";

    expect(getComputedStyle(element(".diff-add")).backgroundColor).not.toBe(light);
  });
});

/**
 * The hover tools stay at the top right of the block. A code block shows a long line by
 * scrolling sideways, so if the tools flowed with its contents, the copy button would leave
 * the screen the moment the reader scrolled to the part they want to read.
 */
const LONG_LINE = "const answer = 1;".padEnd(400, "-");

/** The same tools markdown.ts attaches to a code block */
const TOOLS =
  '<div class="preview-tools"><span class="preview-tools-lang">ts</span>' +
  '<button type="button" class="preview-tool" data-action="copy">c</button></div>';

function mountCodeBlock(tools: string): void {
  document.body.innerHTML = `
    <div class="detail-pane">
      <div class="detail-body">
        <div class="markdown-preview" style="width: 320px">
          <pre class="shiki">${tools}<code>${LONG_LINE}</code></pre>
        </div>
      </div>
    </div>`;
}

describe("hover tools in the preview", () => {
  beforeAll(async () => {
    await import("../index.css");
    await import("./workspace.css");
    await import("./markdown-preview.css");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays inside the visible block when the code is scrolled sideways", () => {
    mountCodeBlock(TOOLS);
    const pre = element("pre");
    const code = element("pre code");

    // Scroll both, so that "scrolled right" holds whichever one is the scroll box
    pre.scrollLeft = pre.scrollWidth;
    code.scrollLeft = code.scrollWidth;

    // There is length to scroll sideways at all (at 0 here, the rest checks nothing)
    expect(Math.max(pre.scrollLeft, code.scrollLeft)).toBeGreaterThan(0);
    const tools = element(".preview-tools").getBoundingClientRect();
    const block = pre.getBoundingClientRect();
    expect(tools.right).toBeLessThanOrEqual(block.right);
    expect(tools.left).toBeGreaterThan(block.left);
  });

  // The tools do not change the height of the page. A block whose height differs between
  // the editor and reading shifts the body (#168)
  it("adds nothing to the height of the block it sits in", () => {
    mountCodeBlock(TOOLS);
    const withTools = element("pre").getBoundingClientRect().height;

    mountCodeBlock("");

    expect(element("pre").getBoundingClientRect().height).toBe(withTools);
  });
});
