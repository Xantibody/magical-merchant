import { describe, it, expect } from "vitest";
import { renderDiagrams } from "./mermaid";

const FLOWCHART = ["flowchart TD", "  A[Start] --> B[End]"].join("\n");
const SEQUENCE = ["sequenceDiagram", "  Alice->>Bob: こんにちは", "  Bob-->>Alice: やあ"].join(
  "\n",
);
/** ノート側から初期化を上書きしにくる図。同期先から降ってきた本文でも起こりうる */
const HTML_LABEL_DIRECTIVE = [
  '%%{init: {"htmlLabels": true}}%%',
  "flowchart TD",
  "  A[Start] --> B[End]",
].join("\n");
/** 古い書き方の同じ攻撃。flowchart.htmlLabels も同じ名前なので同じ守りに入る */
const FLOWCHART_HTML_LABEL_DIRECTIVE = [
  '%%{init: {"flowchart": {"htmlLabels": true}}}%%',
  "flowchart TD",
  "  A[Start] --> B[End]",
].join("\n");

/** 描けた図だけを取り出す。null は描画に失敗した図 */
function drawn(svgs: (string | null)[]): string[] {
  return svgs.map((svg) => {
    if (svg === null) {
      throw new Error("mermaid did not draw the diagram");
    }
    return svg;
  });
}

describe("renderDiagrams", () => {
  /**
   * foreignObject は HTML なので canvas を汚染し、PNG に描こうとすると例外になる。
   * flowchart だけを見ていると sequence で取りこぼす — どの図でも SVG の text で描く
   */
  it("draws every diagram's labels as svg text, never foreignObject", async () => {
    const [flowchart, sequence] = drawn(await renderDiagrams([FLOWCHART, SEQUENCE]));

    expect(flowchart).not.toContain("foreignObject");
    expect(sequence).not.toContain("foreignObject");
  });

  /**
   * 図の中の `%%{init: …}%%` は初期化の後から設定を書き換えられる。htmlLabels を
   * 取り返されると PNG は「成功」したまま文字だけが抜けるので、ここで止める
   */
  it("does not let a diagram directive turn html labels back on", async () => {
    const [root, scoped] = drawn(
      await renderDiagrams([HTML_LABEL_DIRECTIVE, FLOWCHART_HTML_LABEL_DIRECTIVE]),
    );

    expect(root).not.toContain("foreignObject");
    expect(scoped).not.toContain("foreignObject");
  });

  it("keeps the label text itself", async () => {
    const [sequence] = drawn(await renderDiagrams([SEQUENCE]));

    expect(sequence).toContain("こんにちは");
  });

  it("has no answer for a diagram it cannot parse", async () => {
    await expect(renderDiagrams(["not a diagram at all"])).resolves.toStrictEqual([null]);
  });
});
