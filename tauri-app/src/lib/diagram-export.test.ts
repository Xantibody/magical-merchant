import { describe, it, expect } from "vitest";
import { exportName, naturalSize, rasterize, sizedSvg, textToBase64 } from "./diagram-export";

/** mermaid が返す形。width 100% と max-width で本文幅に収まるようにしてある */
const MERMAID_SVG =
  '<svg id="mermaid-1" width="100%" viewBox="0 0 320.5 120" ' +
  'style="max-width: 320.5px;" role="graphics-document">' +
  '<rect x="0" y="0" width="320" height="120" fill="#fff"></rect>' +
  "<text>A&nbsp;B</text></svg>";

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
}

describe("naturalSize", () => {
  it("reads the viewBox", () => {
    expect(naturalSize(MERMAID_SVG)).toStrictEqual({ width: 320.5, height: 120 });
  });

  it("has no answer for an svg without a viewBox", () => {
    expect(naturalSize("<svg></svg>")).toBeUndefined();
  });
});

describe("sizedSvg", () => {
  it("pins width and height to the viewBox and drops the max-width", () => {
    const sized = sizedSvg(MERMAID_SVG);

    expect(sized).toContain('width="321"');
    expect(sized).toContain('height="120"');
    expect(sized).not.toContain("max-width");
    expect(sized).not.toContain("style=");
  });

  it("writes a standalone svg document", () => {
    const sized = sizedSvg(MERMAID_SVG);

    // 名前空間が無いと、単体のファイルとして開いたビューアは画像と認識しない
    expect(sized).toMatch(/^<svg[^>]* xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    // HTML の実体は文字(U+00A0)に直っている。XML の中で &nbsp; は未定義
    expect(sized).not.toContain("&nbsp;");
    expect(sized).toContain("A\u00A0B");
  });

  it("refuses anything that is not an svg", () => {
    expect(() => sizedSvg("<p>no</p>")).toThrow("not an svg");
  });
});

describe("rasterize", () => {
  it("draws a png at twice the natural size", async () => {
    const base64 = await rasterize(MERMAID_SVG, "#ffffff");

    // PNG の先頭 8 バイト (\x89PNG\r\n\x1a\n)
    expect(base64).toMatch(/^iVBORw0KGgo/u);
    const bitmap = await createImageBitmap(new Blob([bytesOf(base64)], { type: "image/png" }));
    expect([bitmap.width, bitmap.height]).toStrictEqual([641, 240]);
  });
});

describe("exportName", () => {
  it("names the file after the note and the diagram's position", () => {
    expect(exportName("20260903_101010", 2, "svg")).toBe("20260903_101010-2.svg");
  });

  it("falls back to a generic name when there is no note", () => {
    expect(exportName(undefined, 1, "png")).toBe("diagram-1.png");
  });
});

describe("textToBase64", () => {
  it("encodes text as utf-8 bytes", () => {
    expect(textToBase64("図")).toBe("5Zuz");
  });

  it("copes with a payload larger than a call's argument limit", () => {
    const big = "<svg>".padEnd(300_000, "x");

    expect(new TextDecoder().decode(bytesOf(textToBase64(big)))).toBe(big);
  });
});
