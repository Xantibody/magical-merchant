import { describe, it, expect } from "vitest";
import { renderDiagrams } from "./mermaid";

const FLOWCHART = ["flowchart TD", "  A[Start] --> B[End]"].join("\n");
const SEQUENCE = ["sequenceDiagram", "  Alice->>Bob: こんにちは", "  Bob-->>Alice: やあ"].join(
  "\n",
);
/** A diagram that comes to overwrite the initialization from the note side. It can also arrive in a body that came down from sync */
const HTML_LABEL_DIRECTIVE = [
  '%%{init: {"htmlLabels": true}}%%',
  "flowchart TD",
  "  A[Start] --> B[End]",
].join("\n");
/** The same attack in the older spelling. flowchart.htmlLabels carries the same name, so it falls under the same guard */
const FLOWCHART_HTML_LABEL_DIRECTIVE = [
  '%%{init: {"flowchart": {"htmlLabels": true}}}%%',
  "flowchart TD",
  "  A[Start] --> B[End]",
].join("\n");

/** Take out only the diagrams that were drawn. null is a diagram that failed to draw */
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
   * A foreignObject is HTML, so it taints the canvas and throws when it is drawn into a
   * PNG. Watching flowchart alone misses sequence: every diagram draws with SVG text
   */
  it("draws every diagram's labels as svg text, never foreignObject", async () => {
    const [flowchart, sequence] = drawn(await renderDiagrams([FLOWCHART, SEQUENCE]));

    expect(flowchart).not.toContain("foreignObject");
    expect(sequence).not.toContain("foreignObject");
  });

  /**
   * A `%%{init: …}%%` inside a diagram can rewrite the settings after initialization. If
   * htmlLabels is taken back, the PNG stays "successful" while only the text goes missing,
   * so it is stopped here
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
