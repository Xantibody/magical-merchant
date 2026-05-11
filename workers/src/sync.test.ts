import { describe, it, expect } from "vitest";
import {
  computeSyncPlan,
  buildUpdatedState,
  type ClientFile,
  type RemoteFile,
  type SyncState,
} from "./sync";

function client(key: string, hash: string, lastModified = "2026-05-01T12:00:00Z"): ClientFile {
  return { key, hash, last_modified: lastModified };
}

function remote(key: string, lastModified = "2026-05-01T12:00:00Z", size = 100): RemoteFile {
  return { key, lastModified, size };
}

function stateWith(files: Record<string, { hash: string; last_modified: string }>): SyncState {
  return { files, last_sync: "2026-05-01T00:00:00Z" };
}

describe("computeSyncPlan", () => {
  it("returns empty actions when both sides are empty", () => {
    const actions = computeSyncPlan([], [], { files: {}, last_sync: null });
    expect(actions).toEqual([]);
  });

  it("uploads new local-only files", () => {
    const actions = computeSyncPlan([client("notes/a.md", "hash_a")], [], {
      files: {},
      last_sync: null,
    });
    expect(actions).toEqual([{ type: "upload", key: "notes/a.md" }]);
  });

  it("downloads new remote-only files", () => {
    const actions = computeSyncPlan([], [remote("notes/b.md")], { files: {}, last_sync: null });
    expect(actions).toEqual([{ type: "download", key: "notes/b.md" }]);
  });

  it("detects conflict when both exist without prior state", () => {
    const actions = computeSyncPlan(
      [client("notes/c.md", "hash_c", "2026-05-01T10:00:00Z")],
      [remote("notes/c.md", "2026-05-01T14:00:00Z")],
      { files: {}, last_sync: null },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("conflict");
    expect(actions[0].key).toBe("notes/c.md");
    expect(actions[0].resolution).toBe("keep_remote");
    expect(actions[0].conflict_key).toContain("sync-conflict");
  });

  it("no action when nothing changed", () => {
    const actions = computeSyncPlan(
      [client("notes/d.md", "hash_d")],
      [remote("notes/d.md", "2026-05-01T12:00:00Z")],
      stateWith({ "notes/d.md": { hash: "hash_d", last_modified: "2026-05-01T12:00:00Z" } }),
    );
    expect(actions).toEqual([]);
  });

  it("uploads when local modified", () => {
    const actions = computeSyncPlan(
      [client("notes/e.md", "new_hash")],
      [remote("notes/e.md", "2026-05-01T12:00:00Z")],
      stateWith({ "notes/e.md": { hash: "old_hash", last_modified: "2026-05-01T12:00:00Z" } }),
    );
    expect(actions).toEqual([{ type: "upload", key: "notes/e.md" }]);
  });

  it("downloads when remote modified", () => {
    const actions = computeSyncPlan(
      [client("notes/f.md", "hash_f")],
      [remote("notes/f.md", "2026-05-01T14:00:00Z")],
      stateWith({ "notes/f.md": { hash: "hash_f", last_modified: "2026-05-01T12:00:00Z" } }),
    );
    expect(actions).toEqual([{ type: "download", key: "notes/f.md" }]);
  });

  it("detects conflict when both modified", () => {
    const actions = computeSyncPlan(
      [client("notes/g.md", "new_hash", "2026-05-01T15:00:00Z")],
      [remote("notes/g.md", "2026-05-01T14:00:00Z")],
      stateWith({ "notes/g.md": { hash: "old_hash", last_modified: "2026-05-01T12:00:00Z" } }),
    );
    expect(actions[0].type).toBe("conflict");
    expect(actions[0].resolution).toBe("keep_local");
  });

  it("deletes remote when local was deleted (previously synced)", () => {
    const actions = computeSyncPlan(
      [],
      [remote("notes/h.md", "2026-05-01T12:00:00Z")],
      stateWith({ "notes/h.md": { hash: "hash_h", last_modified: "2026-05-01T12:00:00Z" } }),
    );
    expect(actions).toEqual([{ type: "delete_local", key: "notes/h.md" }]);
  });

  it("deletes local when remote was deleted (previously synced)", () => {
    const actions = computeSyncPlan(
      [client("notes/i.md", "hash_i")],
      [],
      stateWith({ "notes/i.md": { hash: "hash_i", last_modified: "2026-05-01T12:00:00Z" } }),
    );
    expect(actions).toEqual([{ type: "delete_remote", key: "notes/i.md" }]);
  });

  it("sorts actions by key", () => {
    const actions = computeSyncPlan([client("notes/z.md", "hz"), client("notes/a.md", "ha")], [], {
      files: {},
      last_sync: null,
    });
    expect(actions[0].key).toBe("notes/a.md");
    expect(actions[1].key).toBe("notes/z.md");
  });

  it("skips _sync-state/ keys", () => {
    const actions = computeSyncPlan([], [remote("_sync-state/user.json")], {
      files: {},
      last_sync: null,
    });
    expect(actions).toEqual([]);
  });
});

describe("buildUpdatedState", () => {
  it("records uploaded files", () => {
    const state: SyncState = { files: {}, last_sync: null };
    const actions = [{ type: "upload" as const, key: "notes/a.md" }];
    const clientFiles = [client("notes/a.md", "hash_a", "2026-05-01T12:00:00Z")];

    const updated = buildUpdatedState(state, actions, clientFiles, []);
    expect(updated.files["notes/a.md"]).toEqual({
      hash: "hash_a",
      last_modified: "2026-05-01T12:00:00Z",
    });
    expect(updated.last_sync).toBeTruthy();
  });

  it("records downloaded files", () => {
    const state: SyncState = { files: {}, last_sync: null };
    const actions = [{ type: "download" as const, key: "notes/b.md" }];
    const remoteFiles = [remote("notes/b.md", "2026-05-01T14:00:00Z")];

    const updated = buildUpdatedState(state, actions, [], remoteFiles);
    expect(updated.files["notes/b.md"]).toEqual({
      hash: "",
      last_modified: "2026-05-01T14:00:00Z",
    });
  });

  it("removes deleted files from state", () => {
    const state = stateWith({ "notes/x.md": { hash: "h", last_modified: "2026-05-01T12:00:00Z" } });
    const actions = [{ type: "delete_remote" as const, key: "notes/x.md" }];

    const updated = buildUpdatedState(state, actions, [], []);
    expect(updated.files["notes/x.md"]).toBeUndefined();
  });
});
