import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { ClientContext } from "./client-context";
import { isStaleSave, onLocalMutation, typedInvoke } from "./commands";

// vi.mock("@tauri-apps/api/core") は使わない。browser mode のモジュールモックは
// サーバー側の単一レジストリ越しに差し替えるため、並列実行下でモックが適用され
// ないまま本物の invoke が渡ることがある (vitest-dev/vitest#8339)。CI だけで
// 落ちる原因だった。mockIPC は window.__TAURI_INTERNALS__ を差し替えるだけで
// モジュールグラフに触らないので、この競合と無縁。
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

  // 自動同期の合図。呼び出し側ごとに書くと必ず取りこぼす
  it("notifies after a write command succeeds", async () => {
    await typedInvoke("update_draft", { filePath: "a.md", body: "x", client: CLIENT });
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

  // 失敗した書き込みで同期すると、書けなかった内容を「同期済み」と見せてしまう
  it("stays quiet when the write fails", async () => {
    mockIPC(() => {
      throw new Error("disk full");
    });
    await expect(typedInvoke("delete_note", { filename: "a.md" })).rejects.toThrow("disk full");
    expect(seen).toHaveLength(0);
  });

  it("stops notifying once unsubscribed", async () => {
    stop();
    await typedInvoke("update_draft", { filePath: "a.md", body: "x", client: CLIENT });
    expect(seen).toHaveLength(0);
  });
});

describe("isStaleSave", () => {
  // update_draft の失敗は kind 付きで届く。stale だけが「読み直して知らせる」に分岐する
  it("recognises the stale kind and nothing else", () => {
    expect(isStaleSave({ kind: "stale", message: "Stale: a.md changed" })).toBe(true);
    expect(isStaleSave({ kind: "other", message: "disk full" })).toBe(false);
    expect(isStaleSave(new Error("stale"))).toBe(false);
    expect(isStaleSave("stale")).toBe(false);
  });
});
