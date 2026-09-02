import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { MemoryRouter, Route } from "@solidjs/router";
import { ShellProvider } from "../lib/shell";
import { readStartFullscreen } from "../lib/fullscreen";
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
let listens = 0;

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
};

function mockCommands(): void {
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

/**
 * onMount が認証イベントを 2 つ listen し終えるまで待つ。途中でテストが
 * 終わると clearMocks に transformCallback を消され、後続の listen が落ちる
 */
async function renderSettings(): Promise<void> {
  render(() => (
    <ShellProvider>
      <MemoryRouter>
        <Route path="/" component={Settings} />
      </MemoryRouter>
      <UndoToast />
    </ShellProvider>
  ));
  await waitFor(() => expect(listens).toBe(2));
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("画像を追加", { selector: "input" });
}

function folderInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("フォルダから追加", { selector: "input" });
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
    await renderSettings();

    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());
  });

  // 名前はファイル名から作る。打ち直せるが、大抵はそのままでいい
  it("prefills the name from the chosen file and registers it", async () => {
    await renderSettings();
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
    await renderSettings();
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const file = new File(["GIF89a"], "anim.gif", { type: "image/gif" });
    fireEvent.change(fileInput(), { target: { files: [file] } });

    expect(await screen.findByText("PNG か SVG の画像を選んでください")).toBeDefined();
    expect(screen.queryByLabelText("名前")).toBeNull();
  });

  // フォルダごと選ぶと、名前を訊かずにファイル名で一気に登録する。
  // 混ざった README は落として、数だけ知らせる
  it("registers every png and svg in a chosen folder under its file name", async () => {
    await renderSettings();
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const files = [
      new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" }),
      new File(["png"], "214p.png", { type: "image/png" }),
      new File(["# moves"], "README.md", { type: "text/markdown" }),
    ];
    fireEvent.change(folderInput(), { target: { files } });

    expect(await screen.findByText("2 件を登録(1 件はスキップ)")).toBeDefined();
    expect(saved.map((glyph) => `${glyph.name}.${glyph.format}`)).toStrictEqual([
      "623k.svg",
      "214p.png",
    ]);
    expect(screen.queryByLabelText("名前")).toBeNull();
  });

  // フォルダ選択が出せない WebView のために、複数選択でも同じ道を通る
  it("registers several files picked at once the same way", async () => {
    await renderSettings();
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const files = [
      new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" }),
      new File(["png"], "214p.png", { type: "image/png" }),
    ];
    fireEvent.change(fileInput(), { target: { files } });

    expect(await screen.findByText("2 件を登録しました")).toBeDefined();
    expect(saved).toHaveLength(2);
  });

  // 一枚だけなら、フォルダから選んでも名前を確かめる形のまま
  it("still asks for the name when the folder holds one image", async () => {
    await renderSettings();
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    const file = new File(["<svg/>"], "623K.svg", { type: "image/svg+xml" });
    fireEvent.change(folderInput(), { target: { files: [file] } });

    const name = await screen.findByLabelText<HTMLInputElement>("名前");
    expect(name.value).toBe("623k");
    expect(saved).toHaveLength(0);
  });

  it("will not save a name that breaks the rule", async () => {
    await renderSettings();
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
    await renderSettings();
    await waitFor(() => expect(screen.getByText(":236p:")).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: ":236p: を削除" }));

    await waitFor(() => expect(screen.queryByText(":236p:")).toBeNull());
    expect(deleted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(deleted).toStrictEqual(["236p"]);
  });

  it("keeps the glyph when undo is pressed in time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderSettings();
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
