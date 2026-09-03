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
