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

// vi.mock ではなく mockIPC を使う理由は commands.test.ts に書いたとおり
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
/** `plugin:app|version` の答え。取れない端末を作るテストが null に差し替える */
let appVersion: string | null;

/** Tauri の内部 API に公開の型は無い。テストが触るぶんだけ形を書く */
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
  // 認証イベントの listen / unlisten が要る。mockIPC は invoke しか差し替えない
  tauri.__TAURI_INTERNALS__.transformCallback = () => 1;
  tauri.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

/** テストは Chromium で走るので、実行した Mac の UA が漏れないよう固定する。 */
function pretendUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
}

/** ナビの行。行の名は「題 + 補助」なので、頭で当てる。 */
function navRow(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`, "u") });
}

/**
 * onMount が認証イベントを 2 つ listen し終えるまで待つ。途中でテストが
 * 終わると clearMocks に transformCallback を消され、後続の listen が落ちる。
 *
 * 幅は明示する。設定は 767px 以下で 1 頁ずつになり、既定の幅のままだと
 * 見たい頁が畳まれている
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
 * 「システム」は言語の側にもある。テーマの組の中だけを見る。
 * ToggleGroup の選択は `aria-pressed` で、`radio` ではない。
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

  // 名前はファイル名から作る。打ち直せるが、大抵はそのままでいい
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

  // フォルダごと選ぶと、名前を訊かずにファイル名で一気に登録する。
  // 混ざった README は落として、数だけ知らせる
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

  // フォルダ選択が出せない WebView のために、複数選択でも同じ道を通る
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

  // 一枚だけなら、フォルダから選んでも名前を確かめる形のまま
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

  // 消してすぐ戻せる。5 秒は tombstone で、本当に消えるのはそのあと
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
    // 破棄時の unlisten がモックを使うので、消すのはその後
    cleanup();
    clearMocks();
    localStorage.clear();
  });

  it("offers the switch on a Mac", async () => {
    pretendUserAgent(MAC);

    await renderSettings();

    expect(screen.getByLabelText<HTMLInputElement>("起動時に全画面").checked).toBe(false);
  });

  // 全画面にできる窓は Mac にしかない。Android に出すと押しても何も起きない
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

  // 切るときは窓に触らない。いま全画面で使っているのを設定の操作で解かない
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

// ヘッダーの巡回ボタンから移してきた。年に数回しか触らないものを、毎回見る
// 場所に置いておく理由がない
describe("Settings › THEME", () => {
  beforeEach(() => {
    localStorage.clear();
    listens = 0;
    mockCommands();
  });

  afterEach(() => {
    cleanup();
    clearMocks();
    // 選択はモジュールに残る。次のテストへ持ち越さないよう戻す
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

  // ToggleGroup は選択中をもう一度押すと「どれも選んでいない」を報せる。
  // 設定にその状態は無いので、押しても選択は動かない
  it("keeps the choice when the selected one is pressed again", async () => {
    await renderSettings();
    fireEvent.click(themeChoice("ダーク"));

    fireEvent.click(themeChoice("ダーク"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themeChoice("ダーク").ariaPressed).toBe("true");
  });
});

// 端末に載っているビルドを名乗らせる唯一の場所。Android はここが無いと、
// 古いビルドが残っていることを確かめる手掛かりがまったく無い
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

  // 権限が無い端末でもここで落とさない。設定は同期の設定を直しに来る画面で、
  // バージョンが読めないことより開けないことのほうが困る
  it("says nothing when the version cannot be read", async () => {
    appVersion = null;

    await renderSettings();

    expect(screen.getByText("設定")).toBeDefined();
    await waitFor(() => expect(screen.queryByText(/Magical Merchant/u)).toBeNull());
  });
});

// 1 枚の長い画面を 3 頁に割った。どの設定がどの頁に居るかは、この 3 本が決める
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
    // 全画面の行は Mac だけ。実行した端末の UA で結果を変えさせない
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
    // 頁を替えたら前の頁の操作は残らない
    expect(screen.queryByRole("group", { name: "言語" })).toBeNull();
  });

  it("holds the Workers URL and the account on 同期", async () => {
    await renderSettings("同期");

    expect(screen.getByText("Workers URL")).toBeDefined();
    expect(screen.getByText("未ログイン")).toBeDefined();
    expect(screen.getByRole("button", { name: "Google でログイン" })).toBeDefined();
  });
});

// モバイルは一覧と頁を同時に出せない幅なので、1 枚ずつ送る
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
