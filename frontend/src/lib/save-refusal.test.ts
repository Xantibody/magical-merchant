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
  // The three a reload cannot fix. What was typed goes to the backup side immediately
  it("names the refusals a reload cannot fix", () => {
    expect([broken, missing, notText].map((error) => refusedForGood(error))).toStrictEqual([
      true,
      true,
      true,
    ]);
  });

  // Stale can be written after yielding and reloading. It backs up, then goes on to the reload
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
  // When no backup was kept, whatever the reason, "it was not kept" is said first. That
  // what was typed is nowhere has to arrive before the explanation of the reason
  describe("控えが残らなかったとき", () => {
    it("points at the body still on screen", () => {
      expect(refusalToast(stale, false, TITLE, "draft")).toBe(words().saveNotKept);
      expect(refusalToast(broken, false, TITLE, "draft")).toBe(words().saveNotKept);
    });

    // Once a reload has landed, the body on screen has been replaced by the one from disk
    it("says the draft is gone once a reload replaced it", () => {
      expect(refusalToast(stale, false, TITLE, "reloaded")).toBe(words().staleNotKept);
    });

    // Nothing but stale runs a reload, so even under `reloaded` it can only name the note
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

    // What is not on screen starts with the note's name, whatever the reason
    it("names the note instead of pointing at the one now on screen", () => {
      expect(refusalToast(missing, true, TITLE, "away")).toBe(words().missingNoteAway(TITLE));
      expect(refusalToast(notText, true, TITLE, "away")).toBe(words().notTextNoteAway(TITLE));
      expect(refusalToast(broken, true, TITLE, "away")).toBe(words().brokenMetaAway(TITLE));
    });

    // Even after a reload has landed, what is on screen is not what was typed. Treated the same as `away`
    it("treats a reload the same as being away for the refusals it cannot fix", () => {
      expect(refusalToast(missing, true, TITLE, "reloaded")).toBe(words().missingNoteAway(TITLE));
      expect(refusalToast(broken, true, TITLE, "reloaded")).toBe(words().brokenMetaAway(TITLE));
    });

    it("reports an unnamed failure without claiming the frontmatter is broken", () => {
      for (const screen of ["draft", "away", "reloaded"] as const) {
        expect(refusalToast(new Error("boom"), true, TITLE, screen)).toBe(
          words().saveFailedKept(TITLE),
        );
      }
    });
  });
});
