import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useLocation, useNavigate } from "@solidjs/router";
import type { Location } from "@solidjs/router";
import type { JSX } from "solid-js";
import { useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import { NO_FILTER } from "../lib/browse";
import { t } from "../lib/i18n";
import AppLayout from "./AppLayout";

// AppLayout owns its ShellProvider, so the shell and the URL are read from inside a route. Every
// route mounts the same probe: what matters here is the chrome around it, not the page itself
let shell: Shell | undefined;
let location: Location | undefined;
let navigateTo: ((to: string) => void) | undefined;

function Screen(): JSX.Element {
  shell = useShell();
  location = useLocation();
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return <p class="probe-screen">{location.pathname}</p>;
}

function theShell(): Shell {
  if (!shell) {
    throw new Error("the shell was not captured");
  }
  return shell;
}

/** Where the router stands now, as one string: `/notes?file=…&edit=1`. */
function here(): string {
  if (!location) {
    throw new Error("the location was not captured");
  }
  return `${location.pathname}${location.search}`;
}

/** The ID `create_draft` answers with: the bare filename, as core returns it. */
const NEW_FILE = "20260101_120000.md";

/** The shape of the `CommandError` Tauri rejects with. The frontend reads only `kind`. */
const commandError = (kind: string, message: string): Error =>
  Object.assign(new Error(message), { kind });

let calls: { cmd: string; args: Record<string, unknown> }[];
/** Commands that reject with a CommandError in this test. */
let refused: Set<string>;

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  // Set up and signed in: the first-run card stays away and the dot reads "synced"
  get_sync_config: () => ({
    workers_url: "https://sync.invalid",
    auto_sync: false,
    sync_on_start: false,
  }),
  auth_status: () => true,
  read_glyphs: () => [],
  "plugin:deep-link|get_current": () => null,
  "plugin:geolocation|check_permissions": () => ({
    location: "denied",
    coarseLocation: "denied",
  }),
  create_draft: () => NEW_FILE,
  // The phone's pill counts today's lines, and the one-line window lists them
  read_scrawl_by_date: () => [],
  // What the search field and the palette read the moment they open, with or without a scope
  recent_records: () => [],
  search_records: () => [],
  search_all: () => [],
  list_notes: () => [],
  list_scrawl_dates: () => [],
};

function mockCommands(): void {
  mockIPC(
    (cmd, args) => {
      const payload = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: payload });
      if (refused.has(cmd)) {
        throw commandError("io", `refused: ${cmd}`);
      }
      const handler = HANDLERS[cmd];
      if (!handler) {
        throw new Error(`unexpected command ${cmd}`);
      }
      return handler(payload);
    },
    { shouldMockEvents: true },
  );
}

const ROUTE_PATHS = ["/", "/notes", "/codex", "/browse", "/templates", "/settings"];

/** Mounts the chrome at `/`, then moves to `path` the way a press inside the app would. */
async function renderApp(path = "/"): Promise<void> {
  render(() => (
    <MemoryRouter root={AppLayout}>
      {ROUTE_PATHS.map((routePath) => (
        <Route path={routePath} component={Screen} />
      ))}
    </MemoryRouter>
  ));
  await waitFor(() => expect(location?.pathname).toBe("/"));
  // Signed in and set up: the chrome has finished reading its sync state
  await waitFor(() => expect(calls.some((call) => call.cmd === "auth_status")).toBe(true));
  if (path !== "/") {
    navigateTo?.(path);
  }
  await waitFor(() => expect(here()).toBe(path));
}

/** A key pressed with nothing focused: the window's own listener is the one that hears it. */
function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

const createDrafts = () => calls.filter((call) => call.cmd === "create_draft");

async function setupApp(): Promise<void> {
  await page.viewport(1280, 800);
  // Browser mode keeps a real localStorage: `list-tucked` and the like would leak between tests
  localStorage.clear();
  shell = undefined;
  location = undefined;
  navigateTo = undefined;
  calls = [];
  refused = new Set();
  mockCommands();
}

function teardownApp(): void {
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

describe("AppLayout › キーの振り分け", () => {
  beforeEach(setupApp);
  afterEach(teardownApp);

  it("opens the search field on ⌘K", async () => {
    await renderApp("/notes");

    press("k", { metaKey: true });

    await waitFor(() => expect(theShell().searchSeed()).toStrictEqual({}));
    expect(document.querySelector(".search-input")).not.toBeNull();
  });

  // Browse's one chosen tag is carried in, so the search stays inside what is on screen
  it("opens the search field within the tag chosen on Browse", async () => {
    await renderApp("/browse");
    theShell().setBrowseFilter({ ...NO_FILTER, tags: ["sf6"] });

    press("k", { metaKey: true });

    await waitFor(() => expect(theShell().searchSeed()).toStrictEqual({ tags: ["sf6"] }));
  });

  it("makes a Note from the table's ⌘N and opens it to write", async () => {
    await renderApp("/");

    press("n", { metaKey: true });

    await waitFor(() => expect(here()).toBe(`/notes?file=${NEW_FILE}&edit=1`));
    expect(createDrafts()).toHaveLength(1);
    expect(createDrafts()[0].args).toMatchObject({ body: "", tags: [] });
    expect(createDrafts()[0].args).not.toHaveProperty("kind");
  });

  it("opens the palette on ?", async () => {
    await renderApp("/notes");

    press("?");

    await waitFor(() => expect(theShell().paletteOpen()).toBe(true));
    expect(screen.getByRole("dialog", { name: t().palette.dialogLabel })).toBeDefined();
  });

  it("leaves ? to a field being typed into", async () => {
    await renderApp("/notes");
    const field = document.createElement("input");
    document.body.append(field);

    press("?", {}, field);

    expect(theShell().paletteOpen()).toBe(false);
  });

  // The palette already open keeps the scope it was opened with; a second `?` would reset it
  it("does not reopen the palette on ? while it is open", async () => {
    await renderApp("/notes");
    theShell().openPalette({ tags: ["sf6"] });

    press("?", {}, globalThis);

    expect(theShell().paletteOpen()).toBe(true);
    expect(theShell().paletteScope()).toStrictEqual({ tags: ["sf6"] });
  });

  it.each(["/", "/browse"])("starts a search from a typed character on %s", async (path) => {
    await renderApp(path);

    press("a");

    await waitFor(() => expect(theShell().searchSeed()).toStrictEqual({}));
  });

  // A note's viewer has keys of its own (e and Enter write)
  it("does not start a search from a typed character on /notes", async () => {
    await renderApp("/notes");

    press("a");

    expect(theShell().searchSeed()).toBeNull();
  });

  it("closes the popover and the page alone on Esc", async () => {
    await renderApp("/notes");
    theShell().togglePopover("sync");
    theShell().setPaper(true);

    press("Escape", {}, globalThis);

    expect(theShell().popover()).toBeNull();
    expect(theShell().paper()).toBe(false);
  });

  it("closes the palette and the page alone on Esc", async () => {
    await renderApp("/notes");
    theShell().openPalette();
    theShell().setPaper(true);

    press("Escape", {}, globalThis);

    expect(theShell().paletteOpen()).toBe(false);
    expect(theShell().paper()).toBe(false);
  });
});

/** Which of a phone's four pieces of chrome stand right now. */
function phoneChrome(): { places: boolean; out: boolean; slim: boolean; dot: boolean } {
  return {
    places: document.querySelector(".place-switch") !== null,
    out: document.querySelector(".palm-out") !== null,
    slim: document.querySelector(".palm-slim") !== null,
    dot: document.querySelector(".palm-dot") !== null,
  };
}

const nothing = (): void => {
  // The folded bar reads the title alone; no action of the note is pressed
};

/** A note's part of the status details, as Workspace hands it over. Only the title is read here. */
function noteStateTitled(title: string): Parameters<Shell["setNoteState"]>[0] {
  return {
    title,
    map: false,
    examples: false,
    canCommit: false,
    canRevert: false,
    commit: nothing,
    revert: nothing,
    openSettings: nothing,
    openHistory: nothing,
  };
}

const back = (): void => {
  // A level's way out. Only whether one is set decides what stands
};

describe("AppLayout › スマホの部品が出る条件", () => {
  beforeEach(async () => {
    await setupApp();
    await page.viewport(390, 844);
  });
  afterEach(teardownApp);

  it("stands the pill and the dot at the top of a surface", async () => {
    await renderApp("/notes");

    expect(phoneChrome()).toStrictEqual({ places: true, out: false, slim: false, dot: true });
  });

  it("stands none of them on a wide window, where the rail is", async () => {
    await page.viewport(1280, 800);
    await renderApp("/notes");

    expect(phoneChrome()).toStrictEqual({ places: false, out: false, slim: false, dot: false });
    expect(document.querySelector(".library")).not.toBeNull();
  });

  it("adds the round way out on a level", async () => {
    await renderApp("/notes");

    theShell().setHeaderBack(back);

    await waitFor(() =>
      expect(phoneChrome()).toStrictEqual({ places: true, out: true, slim: false, dot: true }),
    );
  });

  it("folds the pill and the way out into the line of words while reading down", async () => {
    await renderApp("/notes");
    theShell().setHeaderBack(back);

    theShell().setSlim(true);

    await waitFor(() =>
      expect(phoneChrome()).toStrictEqual({ places: true, out: true, slim: true, dot: true }),
    );
    expect(document.querySelector(".place-switch")?.classList).toContain("place-switch--slim");
    expect(document.querySelector(".palm-out")?.classList).toContain("palm-out--slim");
  });

  it("takes everything away for the page alone", async () => {
    await renderApp("/notes");
    theShell().setHeaderBack(back);
    theShell().setSlim(true);

    theShell().setPaper(true);

    await waitFor(() =>
      expect(phoneChrome()).toStrictEqual({ places: false, out: false, slim: false, dot: false }),
    );
  });

  it("gives the foot to the one-line window and keeps the dot", async () => {
    await renderApp("/notes");
    theShell().setHeaderBack(back);
    theShell().setSlim(true);

    theShell().setQuickJot(true);

    await waitFor(() =>
      expect(phoneChrome()).toStrictEqual({ places: false, out: false, slim: false, dot: true }),
    );
  });

  it("gives the foot to the writing screen and keeps the dot", async () => {
    await renderApp("/notes?file=a.md&edit=1");
    theShell().setHeaderBack(back);
    theShell().setSlim(true);

    await waitFor(() => expect(theShell().slim()).toBe(true));
    expect(phoneChrome()).toStrictEqual({ places: false, out: false, slim: false, dot: true });
  });

  // A template open in its editor is a form like writing, and its own bar says its state
  it("gives a template's editor the foot and the top corner", async () => {
    await renderApp("/templates");
    expect(phoneChrome()).toStrictEqual({ places: true, out: false, slim: false, dot: true });

    theShell().setHeaderBack(back);

    await waitFor(() =>
      expect(phoneChrome()).toStrictEqual({ places: false, out: false, slim: false, dot: false }),
    );
  });

  // Beside a title the folded line has room for one half: the save, while all is well
  it("says only the save beside a note's title while all is well", async () => {
    await renderApp("/notes");
    theShell().setHeaderBack(back);
    theShell().setNoteState(noteStateTitled("献立"));

    theShell().setSlim(true);

    await waitFor(() =>
      expect(document.querySelector(".palm-slim-place")?.textContent).toBe("献立"),
    );
    expect(document.querySelector(".palm-slim-words")?.textContent).toBe(t().common.saved);
  });

  it("says the whole state beside a note's title once something is wrong", async () => {
    await renderApp("/notes");
    theShell().setHeaderBack(back);
    theShell().setNoteState(noteStateTitled("献立"));
    theShell().setSaveState({ status: "failed", at: "" });

    theShell().setSlim(true);

    await waitFor(() =>
      expect(document.querySelector(".palm-slim-words")?.textContent).toBe(
        `${t().status.saveFailed} · ${t().sync.synced}`,
      ),
    );
  });

  // At the top of a surface there is no title to name, so the place is named and all is said
  it("says the whole state beside the place's name with no note open", async () => {
    await renderApp("/notes");

    theShell().setSlim(true);

    await waitFor(() =>
      expect(document.querySelector(".palm-slim-place")?.textContent).toBe("Note"),
    );
    expect(document.querySelector(".palm-slim-words")?.textContent).toBe(
      `${t().common.saved} · ${t().sync.synced}`,
    );
  });
});
