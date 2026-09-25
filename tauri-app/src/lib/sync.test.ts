import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { t } from "./i18n";
import { emit } from "@tauri-apps/api/event";
import { EVENTS } from "./events";
import { AUTO_SYNC_DEBOUNCE_MS, RESUME_SYNC_INTERVAL_MS, createSyncState } from "./sync";

// The reason mockIPC is used instead of vi.mock is written in commands.test.ts

/** Tauri's internal API has no public type. Only the parts the tests touch are shaped here */
interface TauriInternals {
  __TAURI_INTERNALS__: { transformCallback: () => number };
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
}
const tauri = globalThis as unknown as TauriInternals;

let handlers: Record<string, () => unknown>;
let calls: string[];
/** Events listened to, in order. `createSyncState` starts its first round after the last one */
let listened: string[];

function mockCommands(): void {
  mockWindows("main");
  listened = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:event|listen") {
      listened.push((args as { event: string }).event);
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

describe("createSyncState sync on start", () => {
  let config: { workers_url: string; auto_sync: boolean; sync_on_start: boolean };

  beforeEach(() => {
    calls = [];
    config = { workers_url: "https://sync.example", auto_sync: false, sync_on_start: true };
    handlers = {
      get_sync_config: () => config,
      auth_status: () => true,
      sync_start: () => null,
    };
    mockCommands();
  });

  afterEach(() => {
    clearMocks();
  });

  const syncStarts = (): number => calls.filter((c) => c === "sync_start").length;

  // A second device that opens on a stale tree would have the user write over it
  it("syncs once when the app starts", async () => {
    const { dispose } = mount();

    await vi.waitFor(() => {
      expect(syncStarts()).toBe(1);
    });
    dispose();
  });

  it("does not sync on start while the setting is off", async () => {
    config.sync_on_start = false;
    const { dispose } = mount();

    await vi.waitFor(() => {
      expect(listened).toContain(EVENTS.AUTH_SUCCESS);
    });
    expect(syncStarts()).toBe(0);
    dispose();
  });

  // Signed out, a sync can only fail, and the failure would pop the popover open on launch
  it("does not sync on start before sign-in", async () => {
    handlers.auth_status = () => false;
    const { state, dispose } = mount();

    await vi.waitFor(() => {
      expect(listened).toContain(EVENTS.AUTH_SUCCESS);
    });
    expect(state.status()).toBe("needs-setup");
    expect(syncStarts()).toBe(0);
    dispose();
  });
});

describe("createSyncState sync on return", () => {
  beforeEach(() => {
    calls = [];
    handlers = {
      get_sync_config: () => ({
        workers_url: "https://sync.example",
        auto_sync: false,
        sync_on_start: true,
      }),
      auth_status: () => true,
      sync_start: () => null,
    };
    mockWindows("main");
    // The round has to end (sync-complete) before another can start, so events are real here
    mockIPC(
      (cmd) => {
        const handler = handlers[cmd];
        if (!handler) {
          throw new Error(`unexpected command ${cmd}`);
        }
        calls.push(cmd);
        return handler();
      },
      { shouldMockEvents: true },
    );
  });

  afterEach(() => {
    clearMocks();
    vi.useRealTimers();
  });

  const syncStarts = (): number => calls.filter((c) => c === "sync_start").length;

  /**
   * Takes over the clock, mounts and lets the start-up sync finish. The fake clock still runs
   * with real time here, so the tests stay well clear of the interval's edge.
   */
  async function mountSynced(): Promise<ReturnType<typeof mount>> {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mounted = mount();
    await vi.waitFor(() => {
      expect(syncStarts()).toBe(1);
    });
    await emit(EVENTS.SYNC_COMPLETE, {
      uploaded: 0,
      downloaded: 0,
      deleted_remote: 0,
      deleted_local: 0,
      conflicts: 0,
      errors: [],
    });
    expect(mounted.state.status()).toBe("success");
    return mounted;
  }

  // Android keeps the process alive, so "start" is mostly a return from the background
  it("syncs again when the app comes back after a while", async () => {
    const { state, dispose } = await mountSynced();

    vi.setSystemTime(Date.now() + RESUME_SYNC_INTERVAL_MS + 1000);
    state.resume();

    expect(syncStarts()).toBe(2);
    dispose();
  });

  // Desktop reports every focus change, which can be seconds apart
  it("does not sync again when the app comes back right away", async () => {
    const { state, dispose } = await mountSynced();

    vi.setSystemTime(Date.now() + RESUME_SYNC_INTERVAL_MS / 2);
    state.resume();

    expect(syncStarts()).toBe(1);
    dispose();
  });
});
