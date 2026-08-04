import { describe, it, expect } from "vitest";
import { deriveState, isUnsafeKey, isValidHash } from "./sync";
import type { BulkRequest, SyncState } from "./sync";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function req(overrides: Partial<BulkRequest> = {}): BulkRequest {
  return {
    uploads: [],
    downloads: [],
    delete_remote: [],
    conflicts: [],
    expected_etag: null,
    ...overrides,
  };
}

function stateWith(key: string, lastModified: string): SyncState {
  return { files: { [key]: { hash: HASH_A, last_modified: lastModified } }, last_sync: null };
}

describe("isUnsafeKey", () => {
  it("rejects path traversal", () => {
    expect(isUnsafeKey("../etc/passwd")).toBe(true);
    expect(isUnsafeKey("notes/../other.md")).toBe(true);
  });

  it("rejects null bytes", () => {
    expect(isUnsafeKey("notes/a\0.md")).toBe(true);
  });

  it("rejects absolute paths", () => {
    expect(isUnsafeKey("/etc/passwd")).toBe(true);
  });

  it("rejects _sync-state/ prefix", () => {
    expect(isUnsafeKey("_sync-state/user.json")).toBe(true);
  });

  it("accepts normal keys", () => {
    expect(isUnsafeKey("notes/a.md")).toBe(false);
    expect(isUnsafeKey("notes/archive/2026/note.md")).toBe(false);
    expect(isUnsafeKey("notes/file.sync-conflict-20260512-120000.md")).toBe(false);
  });
});

describe("isValidHash", () => {
  it("accepts a lowercase sha256 hex digest", () => {
    expect(isValidHash(HASH_A)).toBe(true);
  });

  it("rejects anything that is not 64 lowercase hex chars", () => {
    expect(isValidHash("ABC")).toBe(false);
    expect(isValidHash(HASH_A.toUpperCase())).toBe(false);
    expect(isValidHash(`${HASH_A}0`)).toBe(false);
    expect(isValidHash(null)).toBe(false);
    expect(isValidHash(123)).toBe(false);
  });
});

describe("deriveState", () => {
  const empty: SyncState = { files: {}, last_sync: null };
  const now = Date.parse("2026-08-05T00:00:00Z");

  it("adds uploaded files", () => {
    const state = deriveState(
      empty,
      req({
        uploads: [
          {
            key: "notes/a.md",
            content_base64: "",
            last_modified: "2026-08-04T00:00:00Z",
            hash: HASH_B,
          },
        ],
      }),
      now,
    );
    expect(state.files["notes/a.md"].hash).toBe(HASH_B);
  });

  it("leaves downloaded files untouched", () => {
    const old = stateWith("notes/a.md", "2026-08-01T00:00:00Z");
    const state = deriveState(old, req({ downloads: ["notes/a.md"] }), now);
    expect(state.files["notes/a.md"]).toEqual(old.files["notes/a.md"]);
  });

  it("removes deleted files", () => {
    const old = stateWith("notes/a.md", "2026-08-01T00:00:00Z");
    const state = deriveState(old, req({ delete_remote: ["notes/a.md"] }), now);
    expect(state.files).toEqual({});
  });

  // 版が据え置かれると、他端末が「変更なし」と判断して更新を取りこぼす
  it("keeps the version stamp strictly increasing even when the clock does not move", () => {
    const old = stateWith("notes/a.md", "2026-08-05T00:00:00.000Z");
    const state = deriveState(
      old,
      req({
        uploads: [
          {
            key: "notes/a.md",
            content_base64: "",
            last_modified: "2026-08-04T00:00:00Z",
            hash: HASH_B,
          },
        ],
      }),
      now,
    );
    expect(Date.parse(state.files["notes/a.md"].last_modified)).toBeGreaterThan(
      Date.parse(old.files["notes/a.md"].last_modified),
    );
  });
});
