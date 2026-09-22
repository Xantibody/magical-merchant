import { describe, it, expect, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import {
  glyphFormatOf,
  glyphs,
  planGlyphImport,
  isGlyphName,
  loadGlyphs,
  splitGlyphs,
  suggestGlyphName,
} from "./glyphs";

const NAMES = new Set(["236p", "623k"]);

function answerReadGlyphs(answer: { name: string; url: string }[]): (cmd: string) => unknown {
  return (cmd) => (cmd === "read_glyphs" ? answer : null);
}

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

  // Treating an unregistered name as an image would swallow part of a time or a URL
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

  // `:30:` is part of a time, not a name. It becomes an image only when it is registered
  it("resolves a registered numeric name even when it looks like a time", () => {
    expect(splitGlyphs("12:30:45", new Set(["30"]))).toStrictEqual([
      { text: "12", name: null },
      { text: ":30:", name: "30" },
      { text: "45", name: null },
    ]);
  });

  // `:foo:236p:`: even when the first candidate is unregistered, the next name starts at
  // its closing `:`
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

describe("suggestGlyphName", () => {
  it("lowercases the file stem", () => {
    expect(suggestGlyphName("236P.png")).toBe("236p");
  });

  it("turns characters outside the charset into a dash", () => {
    expect(suggestGlyphName("Dragon Punch (K).svg")).toBe("dragon-punch-k-");
  });

  it("drops leading symbols", () => {
    expect(suggestGlyphName("_-236p.png")).toBe("236p");
  });

  it("keeps the allowed symbols", () => {
    expect(suggestGlyphName("hcb+p_2.png")).toBe("hcb+p_2");
  });

  it("caps at 32 characters", () => {
    expect(suggestGlyphName(`${"a".repeat(40)}.png`)).toHaveLength(32);
  });

  // Some images yield no name. Return empty and let the person type one
  it("returns an empty string when nothing usable is left", () => {
    expect(suggestGlyphName("画像.png")).toBe("");
  });
});

describe("isGlyphName", () => {
  it("matches core's rule", () => {
    expect(isGlyphName("236p")).toBe(true);
    expect(isGlyphName("dp+k")).toBe(true);
    expect(isGlyphName("")).toBe(false);
    expect(isGlyphName("236P")).toBe(false);
    expect(isGlyphName("-lead")).toBe(false);
    expect(isGlyphName("a b")).toBe(false);
    expect(isGlyphName("a".repeat(33))).toBe(false);
  });
});

describe("glyphFormatOf", () => {
  it("reads png and svg from the extension, whatever the case", () => {
    expect(glyphFormatOf("236p.PNG")).toBe("png");
    expect(glyphFormatOf("236p.svg")).toBe("svg");
  });

  it("refuses other images", () => {
    expect(glyphFormatOf("236p.gif")).toBeNull();
    expect(glyphFormatOf("236p")).toBeNull();
  });
});

describe("loadGlyphs", () => {
  afterEach(() => clearMocks());

  it("fills the registry from read_glyphs", async () => {
    mockIPC(answerReadGlyphs([{ name: "236p", url: "data:image/png;base64,x" }]));

    await loadGlyphs();

    expect(glyphs().get("236p")).toBe("data:image/png;base64,x");
  });

  // Emptying it even for an instant turns the drawn images back into text and the layout jumps
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

/** The plan needs only the name and the size, so no real File is built. */
const file = (name: string, size = 100) => ({ name, size });

describe("planGlyphImport", () => {
  it("plans nothing for an empty folder", () => {
    expect(planGlyphImport([])).toStrictEqual({ ready: [], skipped: [] });
  });

  it("names one image after its file stem", () => {
    const png = file("236P.png");

    expect(planGlyphImport([png])).toStrictEqual({
      ready: [{ name: "236p", format: "png", file: png }],
      skipped: [],
    });
  });

  it("keeps the order of the folder for several images", () => {
    const plan = planGlyphImport([file("a.png"), file("b.svg"), file("c.PNG")]);

    expect(plan.ready.map((item) => `${item.name}.${item.format}`)).toStrictEqual([
      "a.png",
      "b.svg",
      "c.png",
    ]);
    expect(plan.skipped).toStrictEqual([]);
  });

  // A folder also holds a README or a GIF. Do not drop them silently: return them with a reason
  it("skips files that are not png or svg", () => {
    const readme = file("README.md");

    expect(planGlyphImport([readme]).skipped).toStrictEqual([
      { file: readme, reason: "unsupported" },
    ]);
  });

  it("skips an image whose stem makes no usable name", () => {
    const jp = file("画像.png");

    expect(planGlyphImport([jp]).skipped).toStrictEqual([{ file: jp, reason: "badName" }]);
  });

  // With two files of the same name, first wins and says so, rather than the later one
  // silently overwriting the earlier
  it("keeps the first of two files that map to the same name", () => {
    const first = file("236p.png");
    const second = file("236P.svg");
    const plan = planGlyphImport([first, second]);

    expect(plan.ready).toStrictEqual([{ name: "236p", format: "png", file: first }]);
    expect(plan.skipped).toStrictEqual([{ file: second, reason: "duplicate" }]);
  });

  // The same 256 KiB as core. Show the reason here, before the IPC fails
  it("skips an image over 256 KiB", () => {
    const big = file("big.png", 256 * 1024 + 1);
    const edge = file("edge.png", 256 * 1024);
    const plan = planGlyphImport([big, edge]);

    expect(plan.ready.map((item) => item.name)).toStrictEqual(["edge"]);
    expect(plan.skipped).toStrictEqual([{ file: big, reason: "tooLarge" }]);
  });

  // The one dropped for being too large does not take the name. The next file of the same
  // name is registered rather than counted as a duplicate
  it("lets a later file take a name the oversized one did not get", () => {
    const plan = planGlyphImport([file("236p.png", 1 << 20), file("236p.svg")]);

    expect(plan.ready.map((item) => item.format)).toStrictEqual(["svg"]);
  });

  // A nested folder can arrive with its path. The name is built from the filename alone
  it("uses only the basename of a nested path", () => {
    const nested = file("moves/ryu/236P.png");

    expect(planGlyphImport([nested]).ready).toStrictEqual([
      { name: "236p", format: "png", file: nested },
    ]);
  });
});
