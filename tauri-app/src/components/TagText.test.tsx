import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import TagText from "./TagText";
import { loadGlyphs } from "../lib/glyphs";

const URL_236P = "data:image/svg+xml;base64,PHN2Zy8+";

async function registerGlyphs(assets: { name: string; url: string }[]): Promise<void> {
  mockIPC((cmd) => (cmd === "read_glyphs" ? assets : null));
  await loadGlyphs();
}

describe("TagText", () => {
  beforeEach(() => registerGlyphs([{ name: "236p", url: URL_236P }]));

  afterEach(() => {
    cleanup();
    clearMocks();
    document.body.innerHTML = "";
  });

  it("renders a registered shortcode as an image", () => {
    const { container } = render(() => <TagText text="起き攻めは :236p: 重ね" />);

    const img = container.querySelector<HTMLImageElement>("img.glyph");
    expect(img?.getAttribute("src")).toBe(URL_236P);
    expect(img?.alt).toBe(":236p:");
    expect(container.textContent).toBe("起き攻めは  重ね");
  });

  it("still colours tags around the image", () => {
    const { container } = render(() => <TagText text=":236p: 重ね #fgc" />);

    expect(container.querySelector("img.glyph")).not.toBeNull();
    expect(container.querySelector(".tag-inline")?.textContent).toBe("#fgc");
  });

  // `:` はタグの文字ではないので、`#fgc` は画像の直後でもタグになる
  it("reads a tag glued to the shortcode", () => {
    const { container } = render(() => <TagText text=":236p:#fgc" />);

    expect(container.querySelector(".tag-inline")?.textContent).toBe("#fgc");
  });

  it("leaves an unregistered shortcode and times as text", () => {
    const { container } = render(() => <TagText text="12:30:45 に :foo: を確認" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("12:30:45 に :foo: を確認");
  });

  it("renders plain text when nothing is registered", async () => {
    await registerGlyphs([]);
    const { container } = render(() => <TagText text=":236p:" />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(":236p:");
  });
});
