import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { MemoryRouter, Route } from "@solidjs/router";
import { readStartFullscreen } from "../lib/fullscreen";
import Settings from "./Settings";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36";

const fullscreenCalls: unknown[] = [];
let listens = 0;

/** Tauri の内部 API に公開の型は無い。テストが触るぶんだけ形を書く */
interface TauriInternals {
  __TAURI_INTERNALS__: { transformCallback: () => number };
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
}
const tauri = globalThis as unknown as TauriInternals;

// vi.mock ではなく mockIPC を使う理由は commands.test.ts に書いたとおり
function mockCommands(): void {
  mockWindows("main");
  mockIPC((cmd, args) => {
    switch (cmd) {
      case "list_templates": {
        return [];
      }
      case "get_sync_config": {
        return { workers_url: "", auto_sync: false };
      }
      case "is_sync_config_editable": {
        return false;
      }
      case "auth_status": {
        return false;
      }
      case "plugin:event|listen": {
        listens += 1;
        return 1;
      }
      case "plugin:event|unlisten": {
        return null;
      }
      case "plugin:window|set_fullscreen": {
        fullscreenCalls.push(args);
        return null;
      }
      default: {
        throw new Error(`unexpected command ${cmd}`);
      }
    }
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
    <MemoryRouter>
      <Route path="/" component={Settings} />
    </MemoryRouter>
  ));
  await waitFor(() => expect(listens).toBe(2));
}

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
