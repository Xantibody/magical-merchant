import { describe, it, expect } from "vitest";
import { renderDiffBlock } from "./diff-block";

interface RenderedLine {
  className: string;
  text: string;
}

function parse(code: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderDiffBlock(code);
  return host;
}

function lines(code: string): RenderedLine[] {
  return [...parse(code).querySelectorAll(".diff-line")].map((line) => ({
    className: line.className,
    text: line.textContent ?? "",
  }));
}

describe("renderDiffBlock", () => {
  it("keeps the pre/code shell every other code block uses", () => {
    const host = parse("context\n");

    expect(host.querySelector("pre > code")).not.toBeNull();
  });

  it("marks an added line", () => {
    expect(lines("+added\n")).toStrictEqual([{ className: "diff-line diff-add", text: "+added" }]);
  });

  it("marks a removed line", () => {
    expect(lines("-removed\n")).toStrictEqual([
      { className: "diff-line diff-del", text: "-removed" },
    ]);
  });

  it("marks a hunk header", () => {
    expect(lines("@@ -1,3 +1,4 @@\n")).toStrictEqual([
      { className: "diff-line diff-hunk", text: "@@ -1,3 +1,4 @@" },
    ]);
  });

  // The first two lines of a `diff` always start with +++ / ---. Coloured as
  // lines, the whole header looks "added" and "deleted", and where the diff begins cannot be read
  it("leaves the +++ and --- file headers uncoloured", () => {
    expect(lines("--- a/note.md\n+++ b/note.md\n")).toStrictEqual([
      { className: "diff-line", text: "--- a/note.md" },
      { className: "diff-line", text: "+++ b/note.md" },
    ]);
  });

  // The exact string core's diff_note_versions (similar's unified_diff) returns.
  // The version history pane hands this over directly without a fence, so the
  // version ID and `draft` in the header must stay uncoloured, and hunk, added
  // and deleted lines must fall into the existing classes
  it("renders what core's version diff returns, header and all", () => {
    const fromCore =
      "--- 20260917_140300-0123abcd\n+++ draft\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n";

    expect(lines(fromCore)).toStrictEqual([
      { className: "diff-line", text: "--- 20260917_140300-0123abcd" },
      { className: "diff-line", text: "+++ draft" },
      { className: "diff-line diff-hunk", text: "@@ -1,3 +1,4 @@" },
      { className: "diff-line", text: " a" },
      { className: "diff-line diff-del", text: "-b" },
      { className: "diff-line diff-add", text: "+B" },
      { className: "diff-line", text: " c" },
      { className: "diff-line diff-add", text: "+d" },
    ]);
  });

  it("leaves a context line uncoloured", () => {
    expect(lines(" unchanged\n")).toStrictEqual([{ className: "diff-line", text: " unchanged" }]);
  });

  // A blank line as an empty div gets no line box; that line alone loses its
  // height and the diff around it looks squeezed together
  it("keeps a blank line one row tall", () => {
    expect(lines("+a\n\n-b\n")).toStrictEqual([
      { className: "diff-line diff-add", text: "+a" },
      { className: "diff-line", text: " " },
      { className: "diff-line diff-del", text: "-b" },
    ]);
  });

  it("does not add a trailing blank line for the fence's own newline", () => {
    expect(lines("+a\n")).toHaveLength(1);
  });

  it("colours the sign without colouring the code", () => {
    const sign = parse("+added\n").querySelector(".diff-add .diff-sign");

    expect(sign?.textContent).toBe("+");
  });

  it("escapes the code instead of letting it become markup", () => {
    const html = renderDiffBlock("+<script>alert(\"x\" & 'y')</script>\n");

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
  });

  // pre draws newlines as they are. A newline between the line divs adds one
  // blank line per line, and the diff becomes twice as tall
  it("puts nothing between the line elements", () => {
    const html = renderDiffBlock("+a\n-b\n");

    expect(html).not.toContain("\n");
    expect(html).toContain("</div><div");
  });
});
