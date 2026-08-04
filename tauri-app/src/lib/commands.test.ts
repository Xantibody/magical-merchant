import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { onLocalMutation, typedInvoke } from "./commands";

vi.mock(import("@tauri-apps/api/core"), () => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
}));

const invokeMock = vi.mocked(invoke);

describe("typedInvoke local mutation notifications", () => {
  const seen: string[] = [];
  let stop: () => void;

  beforeEach(() => {
    seen.length = 0;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    stop = onLocalMutation(() => seen.push("mutated"));
  });

  afterEach(() => stop());

  // 自動同期の合図。呼び出し側ごとに書くと必ず取りこぼす
  it("notifies after a write command succeeds", async () => {
    await typedInvoke("update_draft", {
      filePath: "a.md",
      body: "x",
      tags: [],
      latitude: null,
      longitude: null,
    });
    expect(seen).toHaveLength(1);
  });

  it("notifies for a quick capture", async () => {
    await typedInvoke("save_quick_capture", { text: "hi", latitude: null, longitude: null });
    expect(seen).toHaveLength(1);
  });

  it("stays quiet for read-only commands", async () => {
    invokeMock.mockResolvedValue([]);
    await typedInvoke("list_notes");
    expect(seen).toHaveLength(0);
  });

  // 失敗した書き込みで同期すると、書けなかった内容を「同期済み」と見せてしまう
  it("stays quiet when the write fails", async () => {
    invokeMock.mockRejectedValue(new Error("disk full"));
    await expect(typedInvoke("delete_note", { filename: "a.md" })).rejects.toThrow("disk full");
    expect(seen).toHaveLength(0);
  });

  it("stops notifying once unsubscribed", async () => {
    stop();
    await typedInvoke("save_document", { body: "x", tags: [], latitude: null, longitude: null });
    expect(seen).toHaveLength(0);
  });
});
