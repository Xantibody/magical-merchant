import { describe, it, expect, vi, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { createWidgetLaunch } from "./widget-launch";
import type { WidgetLaunchDeps } from "./widget-launch";
import { ROUTES } from "./routes";

function launch(): { run: ReturnType<typeof createWidgetLaunch>; deps: WidgetLaunchDeps } {
  const deps: WidgetLaunchDeps = {
    navigate: vi.fn<(path: string) => void>(),
    newNote: vi.fn<() => void>(),
    closePalette: vi.fn<() => void>(),
    refreshData: vi.fn<() => void>(),
    showToast: vi.fn<(text: string) => void>(),
  };
  return { run: createWidgetLaunch(deps), deps };
}

/** Core answers the template with the note it made (or found); every other call is a device probe. */
function stubTemplateCreate(path: string): void {
  mockIPC((cmd) => (cmd === "create_from_template" ? { path } : null));
}

describe("createWidgetLaunch", () => {
  afterEach(() => clearMocks());

  it("starts a new note for the new-note widget", () => {
    const { run, deps } = launch();

    run({ name: "new-note", file: null, template: null });

    expect(deps.newNote).toHaveBeenCalledTimes(1);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("opens the note a list row points at", () => {
    const { run, deps } = launch();

    run({ name: "note", file: "20260320_143045.md", template: null });

    expect(deps.navigate).toHaveBeenCalledWith(`${ROUTES.NOTES}?file=20260320_143045.md`);
  });

  it("goes to the templates screen for a template widget with no buttons", () => {
    const { run, deps } = launch();

    run({ name: "templates", file: null, template: null });

    expect(deps.navigate).toHaveBeenCalledWith(ROUTES.TEMPLATES);
  });

  it("opens today's note from the template in the writing screen", async () => {
    stubTemplateCreate("data/notes/20260320_090000.md");
    const { run, deps } = launch();

    run({ name: "template", file: null, template: "日報" });

    // The device signals are gathered first, and a position fix may take up to its budget
    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(deps.refreshData).toHaveBeenCalledTimes(1);
    expect(deps.navigate).toHaveBeenCalledWith(`${ROUTES.NOTES}?file=20260320_090000.md&edit=1`);
  });

  // The widget may still point at a template that was deleted since it was placed
  it("falls back to the list and says why when the template is gone", async () => {
    mockIPC(() => {
      throw new Error("not found");
    });
    const { run, deps } = launch();

    run({ name: "template", file: null, template: "消えた" });

    await vi.waitFor(() => expect(deps.navigate).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(deps.navigate).toHaveBeenCalledWith(ROUTES.NOTES);
    expect(deps.showToast).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a widget it does not know", () => {
    const { run, deps } = launch();

    run({ name: "mystery", file: null, template: null });
    run({ name: "note", file: null, template: null });

    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.newNote).not.toHaveBeenCalled();
  });
});
