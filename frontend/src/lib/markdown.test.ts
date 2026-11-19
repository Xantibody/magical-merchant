import { describe, it, expect } from "vitest";
import { FENCE_SLOT, renderMarkdown, renderMarkdownSync } from "./markdown";

function kindOf(className: string | undefined): "code" | "diagram" {
  return className?.startsWith("shiki") ? "code" : "diagram";
}

describe("renderMarkdownSync", () => {
  it("converts a heading", () => {
    const html = renderMarkdownSync("# Hello");
    expect(html).toContain("<h1>Hello</h1>");
  });

  it("converts a paragraph", () => {
    const html = renderMarkdownSync("Some text");
    expect(html).toContain("<p>Some text</p>");
  });

  it("converts an unordered list", () => {
    const html = renderMarkdownSync("- item1\n- item2");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item1</li>");
    expect(html).toContain("<li>item2</li>");
  });

  // Emit the same li as the editor (gfm). CSS draws the mark, so the literal `[ ]` is dropped
  it("marks a task list item with its state and drops the bracket", () => {
    const html = renderMarkdownSync("- [ ] 牛乳\n- [x] パン");
    expect(html).toContain('<li data-item-type="task" data-checked="false">牛乳</li>');
    expect(html).toContain('<li data-item-type="task" data-checked="true">パン</li>');
  });

  it("leaves a bracket that is not a task marker as text", () => {
    const html = renderMarkdownSync("- [memo] 牛乳\n- [ ]牛乳");
    expect(html).toContain("<li>[memo] 牛乳</li>");
    expect(html).toContain("<li>[ ]牛乳</li>");
  });

  it("converts inline code", () => {
    const html = renderMarkdownSync("use `foo()` here");
    expect(html).toContain("<code>foo()</code>");
  });

  it("converts bold and italic", () => {
    const html = renderMarkdownSync("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("converts a link", () => {
    const html = renderMarkdownSync("[click](https://example.com)");
    expect(html).toContain('<a href="https://example.com">click</a>');
  });

  it("does not render raw HTML (html: false)", () => {
    const html = renderMarkdownSync('<script>alert("xss")</script>');
    expect(html).not.toContain("<script>");
  });

  it("returns empty string for empty string", () => {
    const html = renderMarkdownSync("");
    expect(html.trim()).toBe("");
  });
});

describe("Milkdown の空行 (<br /> 行)", () => {
  it("単独行の <br /> は文字ではなく空の段落として描く", () => {
    const html = renderMarkdownSync("一段落目\n\n<br />\n\n二段落目");
    expect(html).not.toContain("&lt;br");
    // An empty line becomes an empty paragraph one line high
    expect(html).toContain("<p>\u00A0</p>");
  });

  it("文中の <br> はこれまでどおりエスケープした文字のまま", () => {
    const html = renderMarkdownSync("前 <br> 後");
    expect(html).toContain("&lt;br&gt;");
  });

  it("コードフェンスの中の <br /> はコードのまま", async () => {
    const source = ["```html", "<br />", "```"].join("\n");
    const html = await renderMarkdown(source);
    // Shiki escapes < as &#x3C;. It only has to survive as code
    expect(html).toMatch(/&(?:lt|#x3C);/u);
    expect(html).not.toContain("<p>\u00A0</p>");
  });

  it("フェンス差し込みつきの描画でも空行になる", async () => {
    const source = ["```ts", "const a = 1;", "```", "", "<br />", "", "本文"].join("\n");
    const html = await renderMarkdown(source);
    expect(html).not.toContain("&lt;br");
    expect(html).toContain("<p>\u00A0</p>");
  });
});

describe("renderMarkdown", () => {
  it("highlights every code block", async () => {
    const source = ["```ts", "const a = 1;", "```", "", "```rust", "let b = 2;", "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html.split('<pre class="shiki').length - 1).toBe(2);
  });

  it("leaves no marker behind when the code contains a replacement pattern", async () => {
    // "$&" expands to the whole match in a String.replace replacement string. Passing the
    // replacement as a string mixes the marker markup straight into the body.
    const source = ["```bash", 'echo "cost: 1 $& 2" $` $\' $$', "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain("shiki-placeholder");
    expect(html).not.toContain(FENCE_SLOT);
    expect(html.split('<pre class="shiki').length - 1).toBe(1);
  });

  it("does not let the source forge a slot marker", async () => {
    // This leans on markdown-it crushing U+0000 to U+FFFD. Without that crush, the body
    // could forge the position where the highlight result is spliced in.
    const source = [`${FENCE_SLOT} は本文`, "", "```text", FENCE_SLOT, "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain(FENCE_SLOT);
    expect(html.split('<pre class="shiki').length - 1).toBe(1);
  });

  it("renders prose without a highlighter when there is no code block", async () => {
    const html = await renderMarkdown("# Hello");

    expect(html).toContain("<h1>Hello</h1>");
  });

  // Shiki does not carry diff, so sending it there only drops it to plain text
  it("draws a diff fence with its own renderer instead of the highlighter", async () => {
    const source = ["```diff", "-old", "+new", "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain('<pre class="shiki');
    expect(html).toContain('class="diff-line diff-del"');
    expect(html).toContain('class="diff-line diff-add"');
  });

  // A single handler inside innerHTML catches the copy. Unless the pressed block's raw
  // source can be read from the DOM, it has to be worked back out of the render result
  it("hangs a copy tool and the fence source on a highlighted block", async () => {
    const source = ["```ts", 'const a = "<b>";', "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).toMatch(
      /<pre class="shiki[^>]* data-source="const a = &quot;&lt;b&gt;&quot;;\n"/u,
    );
    expect(html).toContain('data-action="copy"');
    expect(html).toContain('<span class="preview-tools-lang">ts</span>');
    // The tools go inside the block. Outside, they are no reference for positioning the pre
    expect(html.indexOf('data-action="copy"')).toBeLessThan(html.lastIndexOf("</pre>"));
  });

  it("hangs the same copy tool on a diff fence", async () => {
    const source = ["```diff", "+new", "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).toContain('<pre data-source="+new\n"><code>');
    expect(html).toContain('data-action="copy"');
  });

  it("names the copy tool in the current language", async () => {
    const html = await renderMarkdown(["```ts", "1", "```"].join("\n"));

    expect(html).toContain('aria-label="コードをコピー"');
  });

  // Each kind is sorted into its own array to be drawn, so the index slips easily on the way back
  it("keeps a diff fence in source order next to a highlighted one", async () => {
    const source = ["```diff", "+added", "```", "", "```ts", "const a = 1;", "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html.indexOf('class="diff-line diff-add"')).toBeLessThan(
      html.indexOf('<pre class="shiki'),
    );
  });
});

describe("renderMarkdown with mermaid", () => {
  const FLOWCHART = ["```mermaid", "flowchart TD", "  A[Start] --> B[End]", "```"].join("\n");

  it("draws a mermaid fence as a diagram instead of code", async () => {
    const html = await renderMarkdown(FLOWCHART);

    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain("<svg");
    expect(html).not.toContain('<pre class="shiki');
  });

  it("keeps the source readable when the diagram does not parse", async () => {
    const source = ["```mermaid", "これは図ではない {{{", "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain('class="mermaid-block"');
    expect(html).toContain("これは図ではない");
  });

  it("gives every diagram its own id so their styles do not collide", async () => {
    const html = await renderMarkdown(`${FLOWCHART}\n\n${FLOWCHART}`);

    const ids = [...html.matchAll(/<svg[^>]*\sid="(?<id>[^"]+)"/gu)].map(
      (match) => match.groups?.id,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("hangs the caption of a leading %% comment under the diagram", async () => {
    const source = [
      "```mermaid",
      "%% caption: 図1 — 同期の流れ",
      "flowchart TD",
      "  A --> B",
      "```",
    ].join("\n");

    const html = await renderMarkdown(source);

    expect(html).toContain("<figcaption");
    expect(html).toContain("図1 — 同期の流れ");
    // mermaid skips the comment. It is not removed from the body
    expect(html).toContain("<svg");
  });

  it("draws no caption when the diagram has no caption comment", async () => {
    const html = await renderMarkdown(FLOWCHART);

    expect(html).not.toContain("<figcaption");
  });

  it("puts the zoom and export tools inside the figure", async () => {
    const html = await renderMarkdown(FLOWCHART);

    for (const action of ["zoom", "svg", "png"]) {
      const at = html.indexOf(`data-action="${action}"`);
      expect(at).toBeGreaterThan(html.indexOf("<figure"));
      expect(at).toBeLessThan(html.indexOf("</figure>"));
    }
  });

  it("keeps diagrams and code blocks in source order", async () => {
    const source = [FLOWCHART, "", "```ts", "const a = 1;", "```", "", FLOWCHART].join("\n");

    const html = await renderMarkdown(source);

    const kinds = [...html.matchAll(/class="(?<kind>mermaid-block|shiki[^"]*)"/gu)].map((match) =>
      kindOf(match.groups?.kind),
    );
    expect(kinds).toStrictEqual(["diagram", "code", "diagram"]);
  });
});

// The margin mark while the history is open. The diff is not drawn in a separate pane;
// only a class and a sign are added to the body's block. The body's colour and type are left alone
describe("renderMarkdown with line marks", () => {
  it("marks the block a line belongs to and leaves the rest alone", async () => {
    const html = await renderMarkdown("そのまま\n\n増えた\n\n消えた", undefined, undefined, [
      undefined,
      undefined,
      "add",
      undefined,
      "del",
    ]);

    expect(html).toContain("<p>そのまま</p>");
    expect(html).toContain(
      '<p class="diff-mark diff-mark--add"><span class="diff-sign" aria-hidden="true">+</span>増えた</p>',
    );
    expect(html).toContain(
      '<p class="diff-mark diff-mark--del"><span class="diff-sign" aria-hidden="true">−</span>消えた</p>',
    );
  });

  // The paragraph of a tight list item is not drawn. The mark rises onto the item
  it("lifts the mark of a tight list item onto the li", async () => {
    const html = await renderMarkdown("- 残る\n- 増えた", undefined, undefined, [undefined, "add"]);

    expect(html).toContain("<li>残る</li>");
    expect(html).toContain('<li class="diff-mark diff-mark--add"><span class="diff-sign"');
  });

  // When only some lines of a paragraph are deleted, the paragraph is "changed" and only that line's text is struck
  it("strikes only the deleted lines inside a paragraph that survived", async () => {
    const html = await renderMarkdown("一行目\n二行目\n三行目", undefined, undefined, [
      undefined,
      "del",
      undefined,
    ]);

    expect(html).toContain('<p class="diff-mark diff-mark--add">');
    expect(html).toContain('<s class="diff-del-line">二行目</s>');
    expect(html).not.toContain('<s class="diff-del-line">一行目');
  });

  it("puts the mark on a fenced block and a heading", async () => {
    const html = await renderMarkdown("# 見出し\n\n```\ncode\n```", undefined, undefined, [
      "add",
      undefined,
      "del",
      "del",
      "del",
    ]);

    expect(html).toContain('<h1 class="diff-mark diff-mark--add">');
    expect(html).toMatch(/<pre class="diff-mark diff-mark--del[^"]*"/u);
  });

  it("draws nothing extra without marks", async () => {
    const html = await renderMarkdown("本文");

    expect(html).not.toContain("diff-mark");
    expect(html).not.toContain("diff-sign");
  });
});
