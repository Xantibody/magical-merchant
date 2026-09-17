import { describe, it, expect } from "vitest";
import { MODE_ICONS, MODE_LABELS, ROUTES } from "./routes";

// 3 面は記録の熟し方の順に Scrawl(書きなぐり)→ Note(1 本の文書)と呼ぶ。
// 固有名詞なので両言語ともラテン文字のまま(#255)
describe("surface names", () => {
  it("calls the capture journal Scrawl and the workspace Note", () => {
    expect(MODE_LABELS[ROUTES.TIMELINE]).toBe("Scrawl");
    expect(MODE_LABELS[ROUTES.NOTES]).toBe("Note");
  });

  it("marks Scrawl with a scribble, not a lightning bolt", () => {
    expect(MODE_ICONS[ROUTES.TIMELINE]).toBe("scribble-loop");
  });
});
