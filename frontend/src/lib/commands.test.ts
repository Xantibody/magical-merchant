import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { listen } from "@tauri-apps/api/event";
import type { ClientContext } from "./client-context";
import { isStaleSave, onLocalMutation, typedInvoke } from "./commands";
import { describeSyncResult } from "./sync-status";
import type { SyncResultPayload } from "./sync-status";
// There is no node:fs in browser mode. Vite's `?raw` hands the source over as a string.
// oxlint does not know `?raw` and hunts for a default export in a plain .ts, so silence it
// oxlint-disable-next-line import/default
import commandsSource from "./commands.ts?raw";
import mockSource from "../../dev/ipc-mock.js?raw";

// vi.mock("@tauri-apps/api/core") is not used. A module mock in browser mode is swapped in
// through a single registry on the server side, so under parallel runs the real invoke can
// be handed over with the mock never applied (vitest-dev/vitest#8339). That was the cause
// of failures only in CI. mockIPC only replaces window.__TAURI_INTERNALS__ and does not
// touch the module graph, so it is free of that race.
const CLIENT: ClientContext = {
  latitude: null,
  longitude: null,
  battery: null,
  isCharging: null,
  networkType: null,
  osVersion: null,
  locale: null,
};

describe("typedInvoke local mutation notifications", () => {
  const seen: string[] = [];
  let stop: () => void;

  beforeEach(() => {
    seen.length = 0;
    mockIPC(() => null);
    stop = onLocalMutation(() => seen.push("mutated"));
  });

  afterEach(() => {
    stop();
    clearMocks();
  });

  // The signal for automatic sync. Written at each call site, some would always be missed
  it("notifies after a write command succeeds", async () => {
    await typedInvoke("update_draft", { filename: "a.md", body: "x", client: CLIENT });
    expect(seen).toHaveLength(1);
  });

  it("notifies for a quick capture", async () => {
    await typedInvoke("save_quick_capture", { text: "hi", client: CLIENT });
    expect(seen).toHaveLength(1);
  });

  it("stays quiet for read-only commands", async () => {
    mockIPC(() => []);
    await typedInvoke("list_notes");
    expect(seen).toHaveLength(0);
  });

  // Syncing after a failed write would show what could not be written as "synced"
  it("stays quiet when the write fails", async () => {
    mockIPC(() => {
      throw new Error("disk full");
    });
    await expect(typedInvoke("delete_note", { filename: "a.md" })).rejects.toThrow("disk full");
    expect(seen).toHaveLength(0);
  });

  it("stops notifying once unsubscribed", async () => {
    stop();
    await typedInvoke("update_draft", { filename: "a.md", body: "x", client: CLIENT });
    expect(seen).toHaveLength(0);
  });
});

/** Tauri's internal API has no public type. Write only the shape the test touches */
interface TauriInternals {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
}
const tauri = globalThis as unknown as TauriInternals;

/**
 * `CommandMap` is a type, so it cannot be enumerated at run time. Read the declaration
 * itself and pick up the names. If the way it is written changes and nothing can be read,
 * the test fails rather than passing quietly.
 */
function declaredCommands(): string[] {
  const from = commandsSource.indexOf("interface CommandMap {");
  const block = commandsSource.slice(from, commandsSource.indexOf("\n}\n", from));
  return [...block.matchAll(/^ {2}(?<name>[a-z_]+): \{/gmu)]
    .map((match) => match.groups?.name)
    .filter((name) => name !== undefined);
}

// Enforces CLAUDE.md's "every new Tauri command gets a handler in ipc-mock".
// Forget it and only the browser check dies with `mock: unknown command`, and the person
// who notices is whoever opens dev-browser
describe("dev/ipc-mock.js", () => {
  let previous: TauriInternals["__TAURI_INTERNALS__"];

  beforeAll(() => {
    previous = tauri.__TAURI_INTERNALS__;
    // The mock does nothing if someone is there before it. Clear that one out first
    delete tauri.__TAURI_INTERNALS__;
    // A <script>, not `new Function`. This also checks that `__TAURI_INTERNALS__` is placed
    // through the same path as when it is injected into index.html
    const script = document.createElement("script");
    script.textContent = mockSource;
    document.head.append(script);
  });

  afterAll(() => {
    tauri.__TAURI_INTERNALS__ = previous;
  });

  it("answers every command declared in CommandMap", async () => {
    const names = declaredCommands();
    // Zero means "the regex drifted from how the declaration is written", not "the mock is perfect"
    expect(names.length).toBeGreaterThan(0);

    const invoke = tauri.__TAURI_INTERNALS__?.invoke;
    const answers = await Promise.all(
      names.map(async (name) => {
        try {
          // No arguments are passed. The handler tripping inside is fine. All that is
          // being looked at is whether it knows that command
          await invoke?.(name, {});
          return `${name}: ok`;
        } catch (error) {
          return `${name}: ${String(error)}`;
        }
      }),
    );
    expect(answers.filter((answer) => answer.includes("unknown command"))).toStrictEqual([]);
  });

  // A sync result arrives as an event, not as a command's return. If the shape the mock
  // sends drifts from core's `SyncIssue`, the browser check looks like it shows something
  // while on a real device the wording comes out empty
  it("delivers sync results the app can put into words", async () => {
    const results: SyncResultPayload[] = [];
    const unlisten = await listen<SyncResultPayload>("sync-complete", (event) =>
      results.push(event.payload),
    );
    const invoke = tauri.__TAURI_INTERNALS__?.invoke;
    // Success and failure are sent alternately, so pressing twice brings both
    await invoke?.("sync_start", {});
    await invoke?.("sync_start", {});
    await vi.waitFor(() => expect(results).toHaveLength(2));
    unlisten();

    const messages = results.map((result) => describeSyncResult(result).message);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    expect(messages.some((message) => message.includes("notes/20260805_101500.md"))).toBe(true);
  });
});

describe("isStaleSave", () => {
  // An update_draft failure arrives with a kind. Only stale branches to "reload and tell"
  it("recognises the stale kind and nothing else", () => {
    expect(isStaleSave({ kind: "stale", message: "Stale: a.md changed" })).toBe(true);
    expect(isStaleSave({ kind: "other", message: "disk full" })).toBe(false);
    expect(isStaleSave(new Error("stale"))).toBe(false);
    expect(isStaleSave("stale")).toBe(false);
  });
});
