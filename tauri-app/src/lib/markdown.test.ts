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
    // 空行は 1 行ぶんの高さを持つ空の段落になる
    expect(html).toContain("<p>\u00A0</p>");
  });

  it("文中の <br> はこれまでどおりエスケープした文字のまま", () => {
    const html = renderMarkdownSync("前 <br> 後");
    expect(html).toContain("&lt;br&gt;");
  });

  it("コードフェンスの中の <br /> はコードのまま", async () => {
    const source = ["```html", "<br />", "```"].join("\n");
    const html = await renderMarkdown(source);
    // Shiki は < を &#x3C; にエスケープする。コードとして残っていればよい
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
    // "$&" は String.replace の置換文字列ではマッチ全体に展開される。差し替えを
    // 文字列で渡していると、目印の markup がそのまま本文に混ざって出てくる。
    const source = ["```bash", 'echo "cost: 1 $& 2" $` $\' $$', "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain("shiki-placeholder");
    expect(html).not.toContain(FENCE_SLOT);
    expect(html.split('<pre class="shiki').length - 1).toBe(1);
  });

  it("does not let the source forge a slot marker", async () => {
    // markdown-it が U+0000 を U+FFFD に潰すことに寄りかかっている。潰れなければ
    // 本文がハイライト結果の差し込み位置を偽装できてしまう。
    const source = [`${FENCE_SLOT} は本文`, "", "```text", FENCE_SLOT, "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain(FENCE_SLOT);
    expect(html.split('<pre class="shiki').length - 1).toBe(1);
  });

  it("renders prose without a highlighter when there is no code block", async () => {
    const html = await renderMarkdown("# Hello");

    expect(html).toContain("<h1>Hello</h1>");
  });

  // Shiki は diff を持たないので、渡してもプレーンテキストに落ちるだけ
  it("draws a diff fence with its own renderer instead of the highlighter", async () => {
    const source = ["```diff", "-old", "+new", "```"].join("\n");

    const html = await renderMarkdown(source);

    expect(html).not.toContain('<pre class="shiki');
    expect(html).toContain('class="diff-line diff-del"');
    expect(html).toContain('class="diff-line diff-add"');
  });

  // 種類ごとに別の配列へ振り分けて描くので、戻すときの番号がずれやすい
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

    expect(html).not.toContain("<svg");
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

  it("keeps diagrams and code blocks in source order", async () => {
    const source = [FLOWCHART, "", "```ts", "const a = 1;", "```", "", FLOWCHART].join("\n");

    const html = await renderMarkdown(source);

    const kinds = [...html.matchAll(/class="(?<kind>mermaid-block|shiki[^"]*)"/gu)].map((match) =>
      kindOf(match.groups?.kind),
    );
    expect(kinds).toStrictEqual(["diagram", "code", "diagram"]);
  });
});
