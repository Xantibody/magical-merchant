import { describe, it, expect, afterEach } from "vitest";
import "../styles/editor.css";

/**
 * 図だけ表示のとき、ユーザーが最も押すのは描画された図そのもの。
 * ソースを開くクリック ハンドラは preview コンテナに付いているので、
 * SVG の内部要素(図形や foreignObject のラベル)がヒットテストで
 * クリックを食うと、コンテナ余白しか反応しなくなる。
 */
describe("mermaid figure click-through", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("hits the preview container even when the point is inside the svg", () => {
    document.body.innerHTML = `
      <div class="milkdown-editor">
        <div class="milkdown">
          <div class="ProseMirror">
            <div class="code-block-view has-diagram">
              <pre><code>graph TD;</code></pre>
              <div class="mermaid-editor-preview"><svg width="200" height="100" viewBox="0 0 200 100"><g><rect x="0" y="0" width="200" height="100" fill="red"></rect></g></svg></div>
            </div>
          </div>
        </div>
      </div>`;
    const preview = document.querySelector(".mermaid-editor-preview");
    const svg = document.querySelector("svg");
    if (!preview || !svg) {
      throw new Error("fixture not mounted");
    }

    const rect = svg.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);

    expect(hit).toBe(preview);
  });
});
