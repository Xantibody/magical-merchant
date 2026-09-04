import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { t } from "./i18n";
import { createSyncState } from "./sync";

// vi.mock ではなく mockIPC を使う理由は commands.test.ts に書いたとおり

/** Tauri の内部 API に公開の型は無い。テストが触るぶんだけ形を書く */
interface TauriInternals {
  __TAURI_INTERNALS__: { transformCallback: () => number };
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
}
const tauri = globalThis as unknown as TauriInternals;

let handlers: Record<string, () => unknown>;

function mockCommands(): void {
  mockWindows("main");
  mockIPC((cmd) => {
    if (cmd === "plugin:event|listen") {
      return 1;
    }
    if (cmd === "plugin:event|unlisten") {
      return null;
    }
    const handler = handlers[cmd];
    if (!handler) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return handler();
  });
  tauri.__TAURI_INTERNALS__.transformCallback = () => 1;
  tauri.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

/**
 * `onMount` は createRoot のコールバックが返ってから走り、中身は非同期。
 * 何周で落ち着くかは数えず、呼び出し側が `vi.waitFor` で待つ。
 */
function mount(): {
  state: ReturnType<typeof createSyncState>;
  dispose: () => void;
} {
  let state!: ReturnType<typeof createSyncState>;
  const dispose = createRoot((d) => {
    state = createSyncState(() => {});
    return d;
  });
  return { state, dispose };
}

describe("createSyncState readiness", () => {
  beforeEach(() => {
    handlers = {
      get_sync_config: () => ({ workers_url: "", auto_sync: false }),
      auth_status: () => false,
    };
    mockCommands();
  });

  afterEach(() => {
    clearMocks();
  });

  it("treats a missing config as not set up", async () => {
    const { state, dispose } = mount();

    await vi.waitFor(() => {
      expect(state.message()).toBe(t().sync.notConfigured);
    });
    expect(state.status()).toBe("needs-setup");
    dispose();
  });

  // 壊れた設定を「未設定」と見せると、設定画面で入力し直させることになり、
  // その保存が読めなかったファイルを上書きする
  it("reports a damaged config instead of asking for setup", async () => {
    handlers.get_sync_config = () => {
      // 実際の IPC も core の SyncError をそのまま渡してくる。Error ではない
      // oxlint-disable-next-line no-throw-literal
      throw { kind: "configCorrupt", message: "Could not read sync-config.json" };
    };

    const { state, dispose } = mount();

    await vi.waitFor(() => {
      expect(state.message()).toBe(t().sync.configCorrupt);
    });
    expect(state.status()).toBe("error");
    dispose();
  });
});
