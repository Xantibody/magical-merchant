import { describe, it, expect } from "vitest";
import { firstWidgetAction, parseWidgetAction } from "./widget-actions";

describe("parseWidgetAction", () => {
  it("新しいノートのリンクは名前だけを持つ", () => {
    expect(parseWidgetAction("magical-merchant://widget/new-note")).toEqual({
      name: "new-note",
      file: null,
    });
  });

  it("ノートのリンクはファイル名を運ぶ", () => {
    expect(parseWidgetAction("magical-merchant://widget/note?file=20260809_120000.md")).toEqual({
      name: "note",
      file: "20260809_120000.md",
    });
  });

  // 認証のコールバックは同じスキームを使う。拾うとログイン中に画面が飛ぶ
  it("widget 以外のホストは対象外", () => {
    expect(parseWidgetAction("magical-merchant://auth?token=abc")).toBeNull();
  });

  it("パスのないウィジェットリンクは何も指していない", () => {
    expect(parseWidgetAction("magical-merchant://widget")).toBeNull();
    expect(parseWidgetAction("magical-merchant://widget/")).toBeNull();
  });

  it("文字列が URL でなければ無視する", () => {
    expect(parseWidgetAction("not a url")).toBeNull();
  });
});

describe("firstWidgetAction", () => {
  it("認証の URL が混ざっていてもウィジェットのものを見つける", () => {
    const found = firstWidgetAction([
      "magical-merchant://auth?token=abc",
      "magical-merchant://widget/new-note",
    ]);
    expect(found?.name).toBe("new-note");
  });

  it("ウィジェットのリンクが無ければ null", () => {
    expect(firstWidgetAction(["magical-merchant://auth?token=abc"])).toBeNull();
  });
});
