import { describe, it, expect } from "vitest";
import { HIT_ICONS, MODE_ICONS, MODE_LABELS, ROUTES } from "./routes";

// The three surfaces are named in the order a record ripens: Scrawl (scribbled down) ->
// Note (one document) -> Codex (a document that keeps being added to). They are proper
// nouns, so both languages keep them in Latin letters (#255)
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

  // Search rows and backlink rows say which surface a record is on with an icon. An icon other
  // than the tab's makes one record look like a scribble on the tab and a bolt in the row
  it("marks a hit with the icon of the surface it lives on", () => {
    expect(HIT_ICONS.scrawl).toBe("scribble-loop");
    expect(HIT_ICONS.note).toBe("note-pencil");
    expect(HIT_ICONS.codex).toBe("book");
  });
});
