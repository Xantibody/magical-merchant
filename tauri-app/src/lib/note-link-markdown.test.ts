import { describe, it, expect } from "vitest";
import { renderMarkdownSync } from "./markdown";

const TITLES = new Map([["20260813_083000", "短いメモ"]]);

describe("note links in the preview", () => {
  it("renders a known link as its resolved title", () => {
    const html = renderMarkdownSync("見よ [[20260813_083000]] を", TITLES);

    expect(html).toContain('data-file="20260813_083000.md"');
    expect(html).toContain("短いメモ");
    expect(html).not.toContain("[[20260813_083000]]");
  });

  // 指し先が消えたリンク。タイトルに化けさせると「あるはずのノート」に
  // 見えてしまうので、保存形のまま出す
  it("leaves an unresolvable link as raw text", () => {
    const html = renderMarkdownSync("[[20990101_000000]]", TITLES);

    expect(html).toContain("[[20990101_000000]]");
    expect(html).not.toContain("data-file");
  });

  it("does not touch links inside code spans", () => {
    const html = renderMarkdownSync("`[[20260813_083000]]`", TITLES);

    expect(html).toContain("[[20260813_083000]]");
    expect(html).not.toContain("data-file");
  });

  it("renders the display text instead of the title", () => {
    const html = renderMarkdownSync("詳しくは [[20260813_083000|前の話]] を見る", TITLES);

    expect(html).toContain('data-file="20260813_083000.md"');
    expect(html).toContain("前の話");
    expect(html).not.toContain("短いメモ");
  });

  // 表示文字が付いていても、指し先が無いなら「あるはずのノート」に
  // 見せてはいけない
  it("leaves an unresolvable link with display text as raw text", () => {
    const html = renderMarkdownSync("[[20990101_000000|消えたノート]]", TITLES);

    expect(html).toContain("[[20990101_000000|消えたノート]]");
    expect(html).not.toContain("data-file");
  });

  it("escapes a hostile display text", () => {
    const html = renderMarkdownSync('[[20260813_083000|<img src="x">]]', TITLES);

    expect(html).not.toContain("<img");
  });

  it("escapes a hostile title", () => {
    const titles = new Map([["20260813_083000", '<img src="x">']]);
    const html = renderMarkdownSync("[[20260813_083000]]", titles);

    expect(html).not.toContain("<img");
  });

  it("renders without a title map as before", () => {
    expect(renderMarkdownSync("[[20260813_083000]]")).toContain("[[20260813_083000]]");
  });
});
