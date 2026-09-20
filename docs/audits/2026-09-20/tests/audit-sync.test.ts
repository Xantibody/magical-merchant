import { it, expect, vi, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { createSyncState } from "./sync";
import { typedInvoke } from "./commands";
import { EVENTS } from "./events";

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

async function setup() {
  let config = { workers_url: "https://example.invalid", auto_sync: true };
  const callbacks = new Map<number, (value: unknown) => void>();
  const events = new Map<string, number>();
  let count = 0;
  mockWindows("main");
  mockIPC((cmd, args: any) => {
    if (cmd === "plugin:event|listen") {
      events.set(args.event, args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") return null;
    if (cmd === "get_sync_config") return config;
    if (cmd === "save_sync_config") {
      config = args.config;
      return null;
    }
    if (cmd === "auth_status") return true;
    if (cmd === "sync_start") {
      count++;
      return null;
    }
    if (cmd === "update_draft") return "revision";
    throw new Error(cmd);
  });
  const host = globalThis as any;
  host.__TAURI_INTERNALS__.transformCallback = (fn: (value: unknown) => void) => {
    const id = callbacks.size + 1;
    callbacks.set(id, fn);
    return id;
  };
  host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  let state!: ReturnType<typeof createSyncState>;
  const dispose = createRoot((d) => {
    state = createSyncState(() => {});
    return d;
  });
  await vi.waitFor(() => expect(events.has(EVENTS.SYNC_COMPLETE)).toBe(true));
  vi.useFakeTimers();
  return {
    state,
    dispose,
    count: () => count,
    complete() {
      callbacks.get(events.get(EVENTS.SYNC_COMPLETE)!)!({
        event: EVENTS.SYNC_COMPLETE,
        id: 1,
        payload: {
          uploaded: 0,
          downloaded: 0,
          deleted_local: 0,
          deleted_remote: 0,
          conflicts: 0,
          errors: [],
        },
      });
    },
    mutate: () =>
      typedInvoke("update_draft", {
        filename: "20260920_120000.md",
        body: "new",
        revision: "old",
        client: {},
      }),
  };
}

it("audit: saving during a long sync must schedule a follow-up sync", async () => {
  const h = await setup();
  await h.state.syncNow();
  await h.mutate();
  await vi.advanceTimersByTimeAsync(6000);
  h.complete();
  await vi.advanceTimersByTimeAsync(6000);
  const calls = h.count();
  h.dispose();
  expect(calls).toBe(2);
});

it("audit: disabling autosync must cancel an already scheduled sync", async () => {
  const h = await setup();
  await h.mutate();
  await h.state.setAutoSync(false);
  await vi.advanceTimersByTimeAsync(6000);
  const calls = h.count();
  h.dispose();
  expect(calls).toBe(0);
});
