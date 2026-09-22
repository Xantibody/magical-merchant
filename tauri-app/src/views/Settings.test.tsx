import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { page } from "vitest/browser";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { MemoryRouter, Route } from "@solidjs/router";
import { ShellProvider } from "../lib/shell";
import { readStartFullscreen } from "../lib/fullscreen";
import { chooseTheme } from "../lib/theme";
import UndoToast from "../components/UndoToast";
import Settings from "./Settings";

// The reason for mockIPC rather than vi.mock is written in commands.test.ts
const URL_236P = "data:image/svg+xml;base64,PHN2Zy8+";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";

interface SavedGlyph {
  name: string;
  format: string;
  dataBase64: string;
}

const saved: SavedGlyph[] = [];
const deleted: string[] = [];
const fullscreenCalls: unknown[] = [];
let listens: number;
/** The answer to `plugin:app|version`. A test making a device that cannot read it sets null */
let appVersion: string | null;

/** Tauri's internal API has no public type. Only the shape the tests touch is written */
interface TauriInternals {
  __TAURI_INTERNALS__: { transformCallback: () => number };
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
}
const tauri = globalThis as unknown as TauriInternals;

const HANDLERS: Record<string, (args: unknown) => unknown> = {
  list_glyphs: () => [{ name: "236p", filename: "236p.svg", format: "svg", bytes: 512 }],
  read_glyphs: () => [{ name: "236p", url: URL_236P }],
  save_glyph: (args) => {
    saved.push(args as SavedGlyph);
  },
  delete_glyph: (args) => {
    deleted.push((args as { name: string }).name);
  },
  list_templates: () => [],
  get_sync_config: () => ({ workers_url: "", auto_sync: false }),
  is_sync_config_editable: () => false,
  auth_status: () => false,
  "plugin:event|listen": () => {
    listens += 1;
    return 1;
  },
  "plugin:event|unlisten": () => null,
  "plugin:window|set_fullscreen": (args) => {
    fullscreenCalls.push(args);
    return null;
  },
  "plugin:app|version": () => {
    if (appVersion === null) {
      throw new Error("app.version not allowed");
    }
    return appVersion;
  },
};

function mockCommands(): void {
  appVersion = "1.2.3";
  mockWindows("main");
  mockIPC((cmd, args) => {
    const handler = HANDLERS[cmd];
    if (!handler) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return handler(args);
  });
  // The auth events need listen / unlisten. mockIPC only replaces invoke
  tauri.__TAURI_INTERNALS__.transformCallback = () => 1;
  tauri.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

/** The tests run in Chromium, so the UA is pinned to keep the host Mac's out of them. */
function pretendUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
}

/** A nav row. A row's name is "title + subtitle", so it is matched at the head. */
function navRow(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`, "u") });
}

/**
 * Wait until onMount has finished listening to the two auth events. If a test ends part
 * way, clearMocks removes transformCallback and the later listen fails.
 *
 * The width is set explicitly. Settings shows one page at a time at 767px and below, and
 * at the default width the page under test is folded away
 */
async function renderSettings(open?: string): Promise<void> {
  await page.viewport(1280, 800);
  render(() => (
    <ShellProvider>
      <MemoryRouter>
        <Route path="/" component={Settings} />
      </MemoryRouter>
      <UndoToast />
    </ShellProvider>
  ));
  await waitFor(() => expect(listens).toBe(2));
  if (open) {
    fireEvent.click(navRow(open));
  }
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("画像を追加", { selector: "input" });
}

function folderInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("フォルダから追加", { selector: "input" });
}

/**
 * "System" exists on the language side too. Only the theme group is looked at.
 * A ToggleGroup's selection is `aria-pressed`, not `radio`.
 */
function themeChoice(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "テーマ" })).getByRole("button", { name });
}

describe("Settings › GLYPHS", () => {
  beforeEach(() => {
    saved.length = 0;
    deleted.length = 0;
    listens = 0;
    mockCommands();
  });

  afterEach(() => {
    cleanup();
    clearMocks();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("lists every registered glyph as its shortcode", async () => {
    await renderSettings("記録");

    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());
  });

  // The name is made from the file name. It can be retyped, but usually it is fine as is
  it("prefills the name from the chosen file and registers it", async () => {
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const file = new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    const name = await screen.findByLabelText<HTMLInputElement>("名前");
    expect(name.value).toBe("623k");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe("623k");
    expect(saved[0].format).toBe("svg");
    expect(atob(saved[0].dataBase64)).toBe("<svg/>");
  });

  it("refuses an image that is neither png nor svg", async () => {
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const file = new File(["GIF89a"], "anim.gif", { type: "image/gif" });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    await expect(screen.findByText("PNG か SVG の画像を選んでください")).resolves.toBeDefined();
    expect(screen.queryByLabelText("名前")).toBeNull();
  });

  // Choosing a whole folder registers everything at once under the file names, without
  // asking for a name. A README mixed in is dropped, and only the count is reported
  it("registers every png and svg in a chosen folder under its file name", async () => {
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const files = [
      new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" }),
      new File(["png"], "214p.png", { type: "image/png" }),
      new File(["# moves"], "README.md", { type: "text/markdown" }),
    ];
    fireEvent.change(folderInput(), { target: { files } });

    await expect(screen.findByText("2 件を登録(1 件はスキップ)")).resolves.toBeDefined();
    expect(saved.map((glyph) => `${glyph.name}.${glyph.format}`)).toStrictEqual([
      "623k.svg",
      "214p.png",
    ]);
    expect(screen.queryByLabelText("名前")).toBeNull();
  });

  // For a WebView that cannot offer folder picking, a multi-selection takes the same path
  it("registers several files picked at once the same way", async () => {
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const files = [
      new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" }),
      new File(["png"], "214p.png", { type: "image/png" }),
    ];
    fireEvent.change(fileInput(), { target: { files } });

    await expect(screen.findByText("2 件を登録しました")).resolves.toBeDefined();
    expect(saved).toHaveLength(2);
  });

  // With only one image, picking from a folder still confirms the name
  it("still asks for the name when the folder holds one image", async () => {
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const file = new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" });
    fireEvent.change(folderInput(), { target: { files: [file] } });

    const name = await screen.findByLabelText<HTMLInputElement>("名前");
    expect(name.value).toBe("623k");
    expect(saved).toHaveLength(0);
  });

  it("will not save a name that breaks the rule", async () => {
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());
    const file = new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });
    fireEvent.change(fileInput(), { target: { files: [file] } });
    const name = await screen.findByLabelText<HTMLInputElement>("名前");

    fireEvent.input(name, { target: { value: "Bad Name" } });

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled).toBe(true);
  });

  // A deletion can be undone at once. Five seconds is a tombstone; it really goes after that
  it("deletes after the undo window", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: ":236p: を削除" }));

    await waitFor(() => expect(screen.queryByText(":236p:")).toBeNull());
    expect(deleted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleted).toStrictEqual(["236p"]);
  });

  it("keeps the glyph when undo is pressed in time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderSettings("記録");
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: ":236p: を削除" }));
    await waitFor(() => expect(screen.queryByText(":236p:")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));

    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleted).toHaveLength(0);
  });
});

describe("Settings › start in fullscreen", () => {
  beforeEach(() => {
    localStorage.clear();
    fullscreenCalls.length = 0;
    listens = 0;
    mockCommands();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "userAgent");
    // The unlisten on teardown uses the mocks, so they are cleared after it
    cleanup();
    clearMocks();
    localStorage.clear();
  });

  it("offers the switch on a Mac", async () => {
    pretendUserAgent(MAC);

    await renderSettings();

    expect(screen.getByLabelText<HTMLInputElement>("起動時に全画面").checked).toBe(false);
  });

  // Only a Mac has a window that can go fullscreen. On Android pressing it would do nothing
  it("hides the switch off a Mac", async () => {
    pretendUserAgent(ANDROID);

    await renderSettings();

    expect(screen.queryByLabelText("起動時に全画面")).toBeNull();
  });

  it("remembers the switch and goes fullscreen right away", async () => {
    pretendUserAgent(MAC);
    await renderSettings();

    fireEvent.click(screen.getByLabelText("起動時に全画面"));

    expect(readStartFullscreen()).toBe(true);
    await waitFor(() => expect(fullscreenCalls).toHaveLength(1));
  });

  // Switching it off leaves the window alone. A setting must not undo a fullscreen in use
  it("leaves the window alone when switched off", async () => {
    pretendUserAgent(MAC);
    await renderSettings();
    const toggle = screen.getByLabelText("起動時に全画面");
    fireEvent.click(toggle);
    await waitFor(() => expect(fullscreenCalls).toHaveLength(1));

    fireEvent.click(toggle);

    expect(readStartFullscreen()).toBe(false);
    expect(fullscreenCalls).toHaveLength(1);
  });
});

// Moved here from the header's cycle button. There is no reason to keep something touched
// a few times a year in a place seen every time
describe("Settings › THEME", () => {
  beforeEach(() => {
    localStorage.clear();
    listens = 0;
    mockCommands();
  });

  afterEach(() => {
    cleanup();
    clearMocks();
    // The choice stays in the module. It is reset so it does not carry into the next test
    chooseTheme("system");
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("starts on the remembered choice", async () => {
    await renderSettings();

    expect(themeChoice("システム").ariaPressed).toBe("true");
  });

  it("paints the app and remembers the choice", async () => {
    await renderSettings();

    fireEvent.click(themeChoice("ダーク"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(themeChoice("ダーク").ariaPressed).toBe("true");
    expect(themeChoice("システム").ariaPressed).toBe("false");
  });

  // Pressing the selected item again makes a ToggleGroup report "nothing is selected".
  // Settings has no such state, so pressing does not move the choice
  it("keeps the choice when the selected one is pressed again", async () => {
    await renderSettings();
    fireEvent.click(themeChoice("ダーク"));

    fireEvent.click(themeChoice("ダーク"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeChoice("ダーク").ariaPressed).toBe("true");
  });
});

// The only place that names the build on the device. Without it, Android gives no clue at
// all that an old build is still installed
describe("Settings › the build", () => {
  beforeEach(() => {
    listens = 0;
    mockCommands();
  });

  afterEach(() => {
    cleanup();
    clearMocks();
  });

  it("names the build at the foot of the nav", async () => {
    await renderSettings();

    await expect(screen.findByText("Magical Merchant 1.2.3")).resolves.toBeDefined();
  });

  // A device without the permission must not fail here. Settings is the screen one comes to
  // in order to fix sync, and failing to open is worse trouble than an unreadable version
  it("says nothing when the version cannot be read", async () => {
    appVersion = null;

    await renderSettings();

    expect(screen.getByText("設定")).toBeDefined();
    await waitFor(() => expect(screen.queryByText(/Magical Merchant/u)).toBeNull());
  });
});

// One long screen was split into three pages. These three tests decide which setting is on which page
describe("Settings › the three pages", () => {
  beforeEach(() => {
    localStorage.clear();
    listens = 0;
    mockCommands();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "userAgent");
    cleanup();
    clearMocks();
    localStorage.clear();
  });

  it("opens on 一般 and holds the language, the theme and the window", async () => {
    // The fullscreen row is Mac only. The host device's UA must not change the result
    pretendUserAgent(MAC);

    await renderSettings();

    expect(navRow("一般").ariaCurrent).toBe("page");
    expect(screen.getByRole("group", { name: "言語" })).toBeDefined();
    expect(screen.getByRole("group", { name: "テーマ" })).toBeDefined();
    expect(screen.getByLabelText("起動時に全画面")).toBeDefined();
  });

  it("holds the templates and the glyphs on 記録", async () => {
    await renderSettings("記録");

    expect(screen.getByRole("link", { name: "テンプレートを管理" })).toBeDefined();
    await waitFor(() => expect(screen.getByLabelText("特殊文字")).toBeDefined());
    // Changing the page leaves none of the previous page's controls behind
    expect(screen.queryByRole("group", { name: "言語" })).toBeNull();
  });

  it("holds the Workers URL and the account on 同期", async () => {
    await renderSettings("同期");

    expect(screen.getByText("Workers URL")).toBeDefined();
    expect(screen.getByText("未ログイン")).toBeDefined();
    expect(screen.getByRole("button", { name: "Google でログイン" })).toBeDefined();
  });
});

// Mobile is too narrow to show the list and a page at once, so they are sent one at a time
describe("Settings › on a phone", () => {
  beforeEach(() => {
    localStorage.clear();
    listens = 0;
    mockCommands();
  });

  afterEach(async () => {
    cleanup();
    clearMocks();
    localStorage.clear();
    await page.viewport(1280, 800);
  });

  it("shows the list first, then one page, and comes back", async () => {
    await renderSettings();
    await page.viewport(414, 896);

    expect(screen.queryByRole("group", { name: "言語" })).toBeNull();

    fireEvent.click(navRow("一般"));
    expect(screen.getByRole("group", { name: "言語" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "設定の一覧に戻る" }));
    expect(screen.queryByRole("group", { name: "言語" })).toBeNull();
    expect(navRow("一般")).toBeDefined();
  });
});
