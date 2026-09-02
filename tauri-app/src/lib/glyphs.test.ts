import { describe, it, expect, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { glyphs, loadGlyphs, splitGlyphs } from "./glyphs";

const NAMES = new Set(["236p", "623k"]);

describe("splitGlyphs", () => {
  it("returns the whole text as one segment when there is no shortcode", () => {
    expect(splitGlyphs("ただの文", NAMES)).toStrictEqual([{ text: "ただの文", name: null }]);
  });

  it("keeps an empty text as one empty segment", () => {
    expect(splitGlyphs("", NAMES)).toStrictEqual([{ text: "", name: null }]);
  });

  it("splits one registered shortcode out of the text", () => {
    expect(splitGlyphs("起き攻めは :236p: 重ね", NAMES)).toStrictEqual([
      { text: "起き攻めは ", name: null },
      { text: ":236p:", name: "236p" },
      { text: " 重ね", name: null },
    ]);
  });

  it("splits several shortcodes", () => {
    expect(splitGlyphs(":623k: から :236p:", NAMES)).toStrictEqual([
      { text: ":623k:", name: "623k" },
      { text: " から ", name: null },
      { text: ":236p:", name: "236p" },
    ]);
  });

  it("splits adjacent shortcodes", () => {
    expect(splitGlyphs(":236p::623k:", NAMES)).toStrictEqual([
      { text: ":236p:", name: "236p" },
      { text: ":623k:", name: "623k" },
    ]);
  });

  it("finds a shortcode inside a word", () => {
    expect(splitGlyphs("a:236p:b", NAMES)).toStrictEqual([
      { text: "a", name: null },
      { text: ":236p:", name: "236p" },
      { text: "b", name: null },
    ]);
  });

  // 登録の無い名前を画像扱いすると、時刻や URL の一部が消える
  it("leaves an unregistered shortcode as text", () => {
    expect(splitGlyphs("これは :foo: のまま", NAMES)).toStrictEqual([
      { text: "これは :foo: のまま", name: null },
    ]);
  });

  it("leaves times like 12:30:45 untouched", () => {
    expect(splitGlyphs("12:30:45 に確認", NAMES)).toStrictEqual([
      { text: "12:30:45 に確認", name: null },
    ]);
  });

  // `:30:` は時刻の一部であって名前ではない。登録があるときだけ画像になる
  it("resolves a registered numeric name even when it looks like a time", () => {
    expect(splitGlyphs("12:30:45", new Set(["30"]))).toStrictEqual([
      { text: "12", name: null },
      { text: ":30:", name: "30" },
      { text: "45", name: null },
    ]);
  });

  // `:foo:236p:` — 先頭の候補が登録に無くても、その閉じ `:` から次の名前が始まる
  it("re-scans from the closing colon of an unregistered candidate", () => {
    expect(splitGlyphs(":foo:236p:", NAMES)).toStrictEqual([
      { text: ":foo", name: null },
      { text: ":236p:", name: "236p" },
    ]);
  });

  it("does not match uppercase names", () => {
    expect(splitGlyphs(":236P:", new Set(["236P", "236p"]))).toStrictEqual([
      { text: ":236P:", name: null },
    ]);
  });

  it("leaves everything alone when nothing is registered", () => {
    expect(splitGlyphs(":236p:", new Set())).toStrictEqual([{ text: ":236p:", name: null }]);
  });
});

describe("loadGlyphs", () => {
  afterEach(() => clearMocks());

  it("fills the registry from read_glyphs", async () => {
    mockIPC((cmd) =>
      cmd === "read_glyphs" ? [{ name: "236p", url: "data:image/png;base64,x" }] : null,
    );

    await loadGlyphs();

    expect(glyphs().get("236p")).toBe("data:image/png;base64,x");
  });

  // 一瞬でも空にすると、描いてある画像が文字に戻ってレイアウトが跳ねる
  it("keeps the previous registry when the read fails", async () => {
    mockIPC(() => [{ name: "236p", url: "data:image/png;base64,x" }]);
    await loadGlyphs();
    mockIPC(() => {
      throw new Error("gone");
    });

    await loadGlyphs();

    expect(glyphs().has("236p")).toBe(true);
  });
});
