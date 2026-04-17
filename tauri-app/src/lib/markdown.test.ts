import { describe, it, expect } from "vitest";
import { renderMarkdownSync } from "./markdown";

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
