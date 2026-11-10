import { describe, it, expect, vi, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { createWidgetLaunch, watchWidgetLaunch } from "./widget-launch";
import type { WidgetLaunchDeps } from "./widget-launch";
import type { WidgetAction } from "./widget-actions";
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

const NEW_NOTE = "magical-merchant://widget/new-note";
const TEMPLATES = "magical-merchant://widget/templates";

/** The plugin hands over `launchUrls`, or refuses with it. Events are mocked. */
function stubLaunch(launchUrls: string[] | Error): void {
  mockIPC(
    (cmd) => {
      if (cmd !== "plugin:deep-link|get_current") {
        return null;
      }
      if (launchUrls instanceof Error) {
        throw launchUrls;
      }
      return launchUrls;
    },
    { shouldMockEvents: true },
  );
}

/** No event plugin: every listen fails, while the launch URLs can still be read. */
function stubNoEvents(launchUrls: string[]): void {
  mockIPC((cmd) => {
    if (cmd === "plugin:event|listen") {
      throw new Error("no event plugin");
    }
    return cmd === "plugin:deep-link|get_current" ? launchUrls : null;
  });
}

/** A widget tapped while the app is already up. */
function tapLater(url: string): Promise<void> {
  return emit("deep-link://new-url", [url]);
}

/** A `run` that keeps the name of every action it was handed. */
function recorder(): { run: (action: WidgetAction) => void; names: string[] } {
  const names: string[] = [];
  return { run: (action) => names.push(action.name), names };
}

describe("watchWidgetLaunch", () => {
  afterEach(() => clearMocks());

  it("runs the tap that launched the app, then every later one until stopped", async () => {
    stubLaunch([NEW_NOTE]);
    const { run, names } = recorder();

    const stop = await watchWidgetLaunch(run);
    await tapLater(TEMPLATES);
    stop();
    await tapLater(NEW_NOTE);

    expect(names).toStrictEqual(["new-note", "templates"]);
  });

  // The whole watch used to reject here, taking the subscription's handle with it, and
  // nothing caught the rejection. Only the launch tap is lost now
  it("keeps the later taps when the launch URL cannot be read", async () => {
    stubLaunch(new Error("refused"));
    const { run, names } = recorder();

    const stop = await watchWidgetLaunch(run);
    await tapLater(TEMPLATES);
    stop();
    await tapLater(NEW_NOTE);

    expect(names).toStrictEqual(["templates"]);
  });

  it("still runs the launch tap when the later ones cannot be listened to", async () => {
    stubNoEvents([NEW_NOTE]);
    const { run, names } = recorder();

    const stop = await watchWidgetLaunch(run);
    stop();

    expect(names).toStrictEqual(["new-note"]);
  });
});
