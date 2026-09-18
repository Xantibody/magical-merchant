import { describe, it, expect } from "vitest";
import { renderDiagrams } from "./mermaid";

const FLOWCHART = ["flowchart TD", "  A[Start] --> B[End]"].join("\n");
const SEQUENCE = ["sequenceDiagram", "  Alice->>Bob: こんにちは", "  Bob-->>Alice: やあ"].join(
  "\n",
);

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

  it("keeps the label text itself", async () => {
    const [sequence] = drawn(await renderDiagrams([SEQUENCE]));

    expect(sequence).toContain("こんにちは");
  });

  it("has no answer for a diagram it cannot parse", async () => {
    await expect(renderDiagrams(["not a diagram at all"])).resolves.toStrictEqual([null]);
  });
});
