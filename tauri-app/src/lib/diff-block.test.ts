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

  // `diff` の 1〜2 行目は必ず +++ / --- で始まる。行として色を付けると
  // ヘッダ全体が「追加」「削除」に見え、どこから差分なのか読めなくなる
  it("leaves the +++ and --- file headers uncoloured", () => {
    expect(lines("--- a/note.md\n+++ b/note.md\n")).toStrictEqual([
      { className: "diff-line", text: "--- a/note.md" },
      { className: "diff-line", text: "+++ b/note.md" },
    ]);
  });

  it("leaves a context line uncoloured", () => {
    expect(lines(" unchanged\n")).toStrictEqual([{ className: "diff-line", text: " unchanged" }]);
  });

  // 空行を空の div にすると行ボックスが立たず、その行だけ高さが消えて
  // 前後の差分が詰まって見える
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

  // pre は改行をそのまま描く。行 div の間に改行を挟むと、行ごとに空行が
  // 1 本ずつ増えて差分が倍の高さになる
  it("puts nothing between the line elements", () => {
    const html = renderDiffBlock("+a\n-b\n");

    expect(html).not.toContain("\n");
    expect(html).toContain("</div><div");
  });
});
