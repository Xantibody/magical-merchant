import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { renderDiffBlock } from "../lib/diff-block";

/**
 * diff の行は「その行が増えたか減ったか」を背景で示す。行の色がコードの
 * 幅で切れて pre の余白まで届かないと、色の帯がブロックの中に浮いて
 * どこまでが 1 行なのか読めなくなる。
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

  // color-mix の相手が欠けていると背景は透明のまま落ちる
  it("tints the row from the status tokens", () => {
    mountDiff("+added\n-removed\n");

    expect(getComputedStyle(element(".diff-add")).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(element(".diff-del")).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  // 明暗それぞれの下地に合う濃さを 1 つの宣言から出すために color-mix にしている。
  // 固定色に戻すと、ダークテーマでは緑と赤が黒い下地の上で浮く
  it("follows the theme without a second rule", () => {
    mountDiff("+added\n");
    const light = getComputedStyle(element(".diff-add")).backgroundColor;

    document.documentElement.dataset.theme = "dark";

    expect(getComputedStyle(element(".diff-add")).backgroundColor).not.toBe(light);
  });
});

/**
 * ホバーツールはブロックの右上に居続ける。コードブロックは横に長い行を
 * スクロールで見せるので、道具がその中身と一緒に流れると、読みたいところへ
 * 寄せた瞬間にコピーのボタンが画面の外へ出ていってしまう。
 */
const LONG_LINE = "const answer = 1;".padEnd(400, "-");

/** markdown.ts がコードブロックに付けるのと同じ道具 */
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

    // どちらがスクロール箱でも「右へ送った」が成り立つよう、両方に送る
    pre.scrollLeft = pre.scrollWidth;
    code.scrollLeft = code.scrollWidth;

    // そもそも横に流れる長さがあること(ここが 0 だと以下は何も見ていない)
    expect(Math.max(pre.scrollLeft, code.scrollLeft)).toBeGreaterThan(0);
    const tools = element(".preview-tools").getBoundingClientRect();
    const block = pre.getBoundingClientRect();
    expect(tools.right).toBeLessThanOrEqual(block.right);
    expect(tools.left).toBeGreaterThan(block.left);
  });

  // 道具は紙面の高さを変えない。エディタと閲覧でブロックの高さが違うと本文がずれる (#168)
  it("adds nothing to the height of the block it sits in", () => {
    mountCodeBlock(TOOLS);
    const withTools = element("pre").getBoundingClientRect().height;

    mountCodeBlock("");

    expect(element("pre").getBoundingClientRect().height).toBe(withTools);
  });
});
