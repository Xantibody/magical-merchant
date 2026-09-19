import { describe, it, expect } from "vitest";
import { refusalToast, refusedForGood } from "./save-refusal";
import { t } from "./i18n";

const TITLE = "歩いた日";

const refusal = (kind: string): unknown => ({ kind, message: kind });

const stale = refusal("stale");
const broken = refusal("broken");
const missing = refusal("missing");
const notText = refusal("notText");

const words = (): ReturnType<typeof t>["notes"] => t().notes;

describe("refusedForGood", () => {
  // 読み直しても直らない 3 つ。打った字はその場で退避する側に回る
  it("names the refusals a reload cannot fix", () => {
    expect([broken, missing, notText].map((error) => refusedForGood(error))).toStrictEqual([
      true,
      true,
      true,
    ]);
  });

  // Stale は譲って読み直せば書ける。退避したうえで読み直しに進む
  it("leaves stale to the reload path", () => {
    expect(refusedForGood(stale)).toBe(false);
  });

  it("is false for anything that is not a refusal", () => {
    const others = [undefined, null, new Error("boom"), { message: "no kind" }];

    expect(others.map((error) => refusedForGood(error))).toStrictEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("refusalToast", () => {
  // 控えが残らなかったときは、どの理由でも先に「残っていない」と言う。
  // 理由の説明より、打った字がどこにも無いことのほうが先に届く必要がある
  describe("控えが残らなかったとき", () => {
    it("points at the body still on screen", () => {
      expect(refusalToast(stale, false, TITLE, "draft")).toBe(words().saveNotKept);
      expect(refusalToast(broken, false, TITLE, "draft")).toBe(words().saveNotKept);
    });

    // 読み直しが載ったぶんは、画面の本文もディスクのぶんに入れ替わっている
    it("says the draft is gone once a reload replaced it", () => {
      expect(refusalToast(stale, false, TITLE, "reloaded")).toBe(words().staleNotKept);
    });

    // Stale 以外は読み直しを走らせないので、`reloaded` でも名乗るしかない
    it("names the note when the screen moved on", () => {
      expect(refusalToast(broken, false, TITLE, "reloaded")).toBe(words().saveNotKeptAway(TITLE));
      expect(refusalToast(stale, false, TITLE, "away")).toBe(words().saveNotKeptAway(TITLE));
    });
  });

  describe("控えが残ったとき", () => {
    it("tells a stale save which side is on screen", () => {
      expect(refusalToast(stale, true, TITLE, "draft")).toBe(words().staleNotReloaded);
      expect(refusalToast(stale, true, TITLE, "reloaded")).toBe(words().editedElsewhere);
      expect(refusalToast(stale, true, TITLE, "away")).toBe(words().editedElsewhereAway(TITLE));
    });

    it("separates a vanished note from a broken record and from bytes that are not text", () => {
      expect(refusalToast(missing, true, TITLE, "draft")).toBe(words().missingNote);
      expect(refusalToast(notText, true, TITLE, "draft")).toBe(words().notTextNote);
      expect(refusalToast(broken, true, TITLE, "draft")).toBe(words().brokenMeta);
    });

    // 画面に無いぶんは、どの理由でもノートの名前から始める
    it("names the note instead of pointing at the one now on screen", () => {
      expect(refusalToast(missing, true, TITLE, "away")).toBe(words().missingNoteAway(TITLE));
      expect(refusalToast(notText, true, TITLE, "away")).toBe(words().notTextNoteAway(TITLE));
      expect(refusalToast(broken, true, TITLE, "away")).toBe(words().brokenMetaAway(TITLE));
    });

    // 読み直しが載ったあとも、画面にあるのは打った字ではない。`away` と同じ扱い
    it("treats a reload the same as being away for the refusals it cannot fix", () => {
      expect(refusalToast(missing, true, TITLE, "reloaded")).toBe(words().missingNoteAway(TITLE));
      expect(refusalToast(broken, true, TITLE, "reloaded")).toBe(words().brokenMetaAway(TITLE));
    });

    // 名前の付かない失敗は「記録が読めない」に倒す。黙って消すより名乗る
    it("falls back to the broken record wording for an unnamed refusal", () => {
      expect(refusalToast(new Error("boom"), true, TITLE, "draft")).toBe(words().brokenMeta);
    });
  });
});
