import { describe, it, expect } from "vitest";
import { HIT_ICONS, MODE_ICONS, MODE_LABELS, ROUTES } from "./routes";

// 3 面は記録の熟し方の順に Scrawl(書きなぐり)→ Note(1 本の文書)→
// Codex(書き足し続ける文書)と呼ぶ。固有名詞なので両言語とも
// ラテン文字のまま(#255)
describe("surface names", () => {
  it("calls the capture journal Scrawl, the workspace Note, the growing document Codex", () => {
    expect(MODE_LABELS[ROUTES.SCRAWL]).toBe("Scrawl");
    expect(MODE_LABELS[ROUTES.NOTES]).toBe("Note");
    expect(MODE_LABELS[ROUTES.CODEX]).toBe("Codex");
  });

  it("marks Scrawl with a scribble, not a lightning bolt", () => {
    expect(MODE_ICONS[ROUTES.SCRAWL]).toBe("scribble-loop");
  });

  it("gives Codex its own surface and a book", () => {
    expect(ROUTES.CODEX).toBe("/codex");
    expect(MODE_ICONS[ROUTES.CODEX]).toBe("book");
  });

  // 検索とバックリンクの行は「どの面の記録か」を印で言う。タブと違う印を
  // 出すと、同じ記録がタブでは走り書き、行では稲妻と別物に見える
  it("marks a hit with the icon of the surface it lives on", () => {
    expect(HIT_ICONS.scrawl).toBe("scribble-loop");
    expect(HIT_ICONS.note).toBe("note-pencil");
    expect(HIT_ICONS.codex).toBe("book");
  });
});
