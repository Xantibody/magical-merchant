import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import { loadSyncState, saveSyncState, executeBulk, deriveState } from "./sync";
import type { BulkRequest, SyncState } from "./sync";

function req(key: string, text: string, hash: string, etag: string | null): BulkRequest {
  return {
    uploads: [
      {
        key,
        content_base64: btoa(text),
        hash: hash.repeat(64),
        last_modified: "2026-09-20T00:00:00Z",
      },
    ],
    downloads: [],
    conflicts: [],
    delete_remote: [],
    expected_etag: etag,
  };
}

it("audit: a rejected CAS must not overwrite a successful writer's object", async () => {
  const bucket = env.BUCKET;
  const user = "audit-cas";
  await saveSyncState(bucket, user, { files: {}, last_sync: null }, null);
  const a = await loadSyncState(bucket, user);
  const b = await loadSyncState(bucket, user);
  const ar = req("notes/audit-cas.md", "accepted A", "a", a.etag);
  const br = req("notes/audit-cas.md", "rejected B", "b", b.etag);
  // Both requests passed handleSyncBulk's initial etag check before either write.
  await executeBulk(bucket, ar);
  expect(await saveSyncState(bucket, user, deriveState(a.state, ar, 1), a.etag)).toBe(true);
  await executeBulk(bucket, br);
  expect(await saveSyncState(bucket, user, deriveState(b.state, br, 2), b.etag)).toBe(false);
  expect(await (await bucket.get(ar.uploads[0].key))!.text()).toBe("accepted A");
});

it("audit: the first state creation must also compare and swap", async () => {
  const bucket = env.BUCKET;
  const user = "audit-first";
  const a = await loadSyncState(bucket, user);
  const b = await loadSyncState(bucket, user);
  const sa: SyncState = {
    files: { "notes/a.md": { hash: "a".repeat(64), last_modified: "2026-09-20T00:00:00Z" } },
    last_sync: null,
  };
  const sb: SyncState = {
    files: { "notes/b.md": { hash: "b".repeat(64), last_modified: "2026-09-20T00:00:00Z" } },
    last_sync: null,
  };
  expect(await saveSyncState(bucket, user, sa, a.etag)).toBe(true);
  expect(await saveSyncState(bucket, user, sb, b.etag)).toBe(false);
});

it("audit: a missing download must not leave a failed bulk partially applied", async () => {
  const bucket = env.BUCKET;
  const key = "notes/audit-partial.md";
  await bucket.put(key, "previous");
  const request = req(key, "uncommitted replacement", "a", null);
  request.downloads.push("notes/audit-missing.md");
  await expect(executeBulk(bucket, request)).rejects.toThrow();
  expect(await (await bucket.get(key))!.text()).toBe("previous");
});
