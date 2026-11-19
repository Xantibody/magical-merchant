import { describe, it, expect, afterEach } from "vitest";
import { setLocale } from "./i18n";
import { HIT_ICONS, MODE_ICONS, MODE_LABELS, ROUTES, routeLabel, settingsPage } from "./routes";

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

// A phone's folded bar names the page it stands on. An English "Settings" or "Browse" on a
// Japanese screen would disagree with pages whose own headings are translated
describe("routeLabel", () => {
  afterEach(() => setLocale("ja"));

  it("names every other page by the title it gives itself, in the reader's language", () => {
    expect(routeLabel(ROUTES.SETTINGS)).toBe("設定");
    expect(routeLabel(ROUTES.TEMPLATES)).toBe("テンプレート");
    expect(routeLabel(ROUTES.BROWSE)).toBe("絞る");

    setLocale("en");
    expect(routeLabel(ROUTES.SETTINGS)).toBe("Settings");
    expect(routeLabel(ROUTES.TEMPLATES)).toBe("Templates");
    expect(routeLabel(ROUTES.BROWSE)).toBe("Filter");
  });

  it("keeps the three surfaces' names in either language", () => {
    for (const lang of ["ja", "en"] as const) {
      setLocale(lang);
      expect(routeLabel(ROUTES.SCRAWL)).toBe("Scrawl");
      expect(routeLabel(ROUTES.NOTES)).toBe("Note");
      expect(routeLabel(ROUTES.CODEX)).toBe("Codex");
    }
  });

  it("reads a path no route knows as Scrawl, where the app falls back to", () => {
    expect(routeLabel("/nowhere")).toBe("Scrawl");
  });
});

// The sync popover's "open Settings" used to land on the general page, one tap short of
// the sync page it was talking about. The page rides on the URL so a link can name it
describe("settingsPage", () => {
  it("names the page in the query so Settings opens on it", () => {
    expect(settingsPage("sync")).toBe("/settings?page=sync");
  });
});
