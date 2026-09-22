import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { t } from "./i18n";
import { AUTO_SYNC_DEBOUNCE_MS, createSyncState } from "./sync";

// The reason mockIPC is used instead of vi.mock is written in commands.test.ts

/** Tauri's internal API has no public type. Only the parts the tests touch are shaped here */
interface TauriInternals {
  __TAURI_INTERNALS__: { transformCallback: () => number };
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
}
const tauri = globalThis as unknown as TauriInternals;

let handlers: Record<string, () => unknown>;
let calls: string[];

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
    calls.push(cmd);
    return handler();
  });
  tauri.__TAURI_INTERNALS__.transformCallback = () => 1;
  tauri.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

/**
 * `onMount` runs after the createRoot callback has returned, and its body is asynchronous.
 * How many turns it takes to settle is not counted; the caller waits with `vi.waitFor`.
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
    calls = [];
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

  // Showing a damaged config as "not set up" makes the user type it again in Settings, and
  // that save overwrites the file that could not be read
  it("reports a damaged config instead of asking for setup", async () => {
    handlers.get_sync_config = () => {
      // The real IPC passes core's SyncError through as it is too. It is not an Error
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

describe("createSyncState auto sync after a busy result", () => {
  beforeEach(() => {
    calls = [];
    handlers = {
      get_sync_config: () => ({ workers_url: "https://sync.example", auto_sync: true }),
      auth_status: () => true,
      sync_start: () => {
        // Another process was holding the same data directory. This is not a fault
        // oxlint-disable-next-line no-throw-literal
        throw { kind: "busy", message: "Sync already in progress" };
      },
    };
    mockCommands();
  });

  afterEach(() => {
    clearMocks();
    vi.useRealTimers();
  });

  /// busy only means "not right now", and dropping it there leaves what was saved unsent
  /// until the next manual sync
  it("retries once after a busy result", async () => {
    const { state, dispose } = mount();
    await vi.waitFor(() => {
      expect(state.status()).toBe("idle");
    });
    vi.useFakeTimers();

    await state.syncNow();

    expect(state.status()).toBe("idle");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(calls.filter((c) => c === "sync_start")).toHaveLength(2);
    dispose();
  });

  /// The other side can be stopped while still holding the lock. The retry is cut off after one
  it("does not retry again when the retry is busy too", async () => {
    const { state, dispose } = mount();
    await vi.waitFor(() => {
      expect(state.status()).toBe("idle");
    });
    vi.useFakeTimers();

    await state.syncNow();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);

    expect(calls.filter((c) => c === "sync_start")).toHaveLength(2);
    dispose();
  });
});
