import { describe, it, expect } from "vitest";
import { renderMarkdown, renderMarkdownSync } from "./markdown";

const URL_236P = "data:image/svg+xml;base64,PHN2Zy8+";
const GLYPHS = new Map([["236p", URL_236P]]);

describe("glyphs in the preview", () => {
  it("renders a registered shortcode as an inline image", () => {
    const html = renderMarkdownSync("起き攻めは :236p: 重ね", undefined, GLYPHS);

    expect(html).toContain(`<img class="glyph" src="${URL_236P}" alt=":236p:" draggable="false">`);
    expect(html).not.toContain(">:236p:<");
  });

  // 登録の無い名前を画像扱いすると、時刻や URL の一部が消える
  it("leaves an unregistered shortcode as text", () => {
    const html = renderMarkdownSync("これは :foo: のまま", undefined, GLYPHS);

    expect(html).toContain(":foo:");
    expect(html).not.toContain("<img");
  });

  it("leaves a time like 12:30:45 alone", () => {
    const html = renderMarkdownSync("12:30:45 に確認", undefined, GLYPHS);

    expect(html).toContain("12:30:45");
    expect(html).not.toContain("<img");
  });

  it("does not touch shortcodes inside code spans", () => {
    const html = renderMarkdownSync("`:236p:`", undefined, GLYPHS);

    expect(html).toContain("<code>:236p:</code>");
    expect(html).not.toContain("<img");
  });

  it("does not touch shortcodes inside fences", async () => {
    const html = await renderMarkdown("```\n:236p:\n```", undefined, GLYPHS);

    expect(html).toContain(":236p:");
    expect(html).not.toContain("<img");
  });

  it("renders adjacent shortcodes as separate images", () => {
    const glyphs = new Map([...GLYPHS, ["623k", "data:image/png;base64,AA=="]]);
    const html = renderMarkdownSync(":236p::623k:", undefined, glyphs);

    expect(html.match(/<img class="glyph"/g)).toHaveLength(2);
  });

  it("works next to a note link", () => {
    const titles = new Map([["20260813_083000", "短いメモ"]]);
    const html = renderMarkdownSync("[[20260813_083000]] :236p:", titles, GLYPHS);

    expect(html).toContain('data-file="20260813_083000.md"');
    expect(html).toContain('<img class="glyph"');
  });

  it("renders without a registry as before", () => {
    expect(renderMarkdownSync(":236p:")).toContain(":236p:");
  });

  it("renders with an empty registry as before", () => {
    expect(renderMarkdownSync(":236p:", undefined, new Map())).toContain(":236p:");
  });
});
