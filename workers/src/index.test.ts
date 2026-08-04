import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { SignJWT } from "jose";
import worker from "./index";

async function makeJwt(
  payload: { sub: string; email: string; exp: number },
  secret = env.JWT_SECRET,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setExpirationTime(payload.exp)
    .sign(key);
}

let validToken: string;

beforeAll(async () => {
  validToken = await makeJwt({
    sub: "user-123",
    email: "test@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
});

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${validToken}` };
}

function request(
  path: string,
  options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
  const headers = { ...authHeader(), ...options.headers };
  return new Request(`http://localhost${path}`, { ...options, headers });
}

async function jsonBody<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function b64(s: string): string {
  return btoa(s);
}

function b64Decode(s: string): string {
  return atob(s);
}

async function clearBucket(): Promise<void> {
  const listed = await env.BUCKET.list({ limit: 1000 });
  if (listed.objects.length > 0) {
    await env.BUCKET.delete(listed.objects.map((o) => o.key));
  }
}

describe("Workers Sync API", () => {
  afterEach(async () => {
    await clearBucket();
  });

  describe("Authentication", () => {
    it("rejects requests without Authorization header", async () => {
      const req = new Request("http://localhost/sync-state");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
    });

    it("rejects invalid JWT", async () => {
      const req = new Request("http://localhost/sync-state", {
        headers: { Authorization: "Bearer invalid" },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
    });

    it("rejects expired JWT", async () => {
      const expiredToken = await makeJwt({
        sub: "user-123",
        email: "test@example.com",
        exp: Math.floor(Date.now() / 1000) - 100,
      });
      const req = new Request("http://localhost/sync-state", {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
    });
  });

  describe("GET /sync-state", () => {
    it("returns empty state for new user", async () => {
      const req = request("/sync-state");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        files: Record<string, unknown>;
        last_sync: string | null;
        etag: string | null;
      }>(res);
      expect(body.files).toEqual({});
      expect(body.last_sync).toBeNull();
      expect(body.etag).toBeNull();
    });

    it("returns saved state with etag", async () => {
      // First, save some state via bulk
      const bulkReq = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [
            {
              key: "notes/a.md",
              content_base64: b64("hello"),
              last_modified: "2026-05-12T10:00:00Z",
            },
          ],
          downloads: [],
          delete_remote: [],
          conflicts: [],
          new_state: {
            files: { "notes/a.md": { hash: "h1", last_modified: "2026-05-12T10:00:00Z" } },
            last_sync: "2026-05-12T10:00:00Z",
          },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(bulkReq, env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);

      // Now read state
      const stateReq = request("/sync-state");
      const ctx2 = createExecutionContext();
      const stateRes = await worker.fetch(stateReq, env, ctx2);
      await waitOnExecutionContext(ctx2);

      expect(stateRes.status).toBe(200);
      const state = await jsonBody<{
        files: Record<string, { hash: string }>;
        etag: string | null;
      }>(stateRes);
      expect(state.files["notes/a.md"].hash).toBe("h1");
      expect(state.etag).toBeTruthy();
    });
  });

  describe("POST /sync/bulk", () => {
    it("uploads files to R2", async () => {
      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [
            {
              key: "notes/up.md",
              content_base64: b64("uploaded content"),
              last_modified: "2026-05-12T10:00:00Z",
            },
          ],
          downloads: [],
          delete_remote: [],
          conflicts: [],
          new_state: {
            files: { "notes/up.md": { hash: "h", last_modified: "2026-05-12T10:00:00Z" } },
            last_sync: "2026-05-12T10:00:00Z",
          },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const obj = await env.BUCKET.get("notes/up.md");
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe("uploaded content");
    });

    it("downloads files from R2", async () => {
      // Pre-populate
      await env.BUCKET.put("notes/down.md", "remote content", {
        customMetadata: { lastModified: "2026-05-12T11:00:00Z" },
      });

      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [],
          downloads: ["notes/down.md"],
          delete_remote: [],
          conflicts: [],
          new_state: { files: {}, last_sync: "2026-05-12T10:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        downloads: { key: string; content_base64: string; last_modified: string }[];
      }>(res);
      expect(body.downloads).toHaveLength(1);
      expect(body.downloads[0].key).toBe("notes/down.md");
      expect(b64Decode(body.downloads[0].content_base64)).toBe("remote content");
    });

    it("deletes remote files", async () => {
      await env.BUCKET.put("notes/del.md", "to delete");

      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [],
          downloads: [],
          delete_remote: ["notes/del.md"],
          conflicts: [],
          new_state: { files: {}, last_sync: "2026-05-12T10:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const obj = await env.BUCKET.get("notes/del.md");
      expect(obj).toBeNull();
    });

    it("handles conflict with keep_local: writes conflict copy + new content", async () => {
      await env.BUCKET.put("notes/c.md", "remote version", {
        customMetadata: { lastModified: "2026-05-12T10:00:00Z" },
      });

      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [],
          downloads: [],
          delete_remote: [],
          conflicts: [
            {
              key: "notes/c.md",
              conflict_key: "notes/c.sync-conflict-20260512-120000.md",
              resolution: "keep_local",
              content_base64: b64("local version"),
            },
          ],
          new_state: { files: {}, last_sync: "2026-05-12T12:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);

      const conflict = await env.BUCKET.get("notes/c.sync-conflict-20260512-120000.md");
      expect(conflict).not.toBeNull();
      expect(await conflict!.text()).toBe("remote version");

      const main = await env.BUCKET.get("notes/c.md");
      expect(await main!.text()).toBe("local version");
    });

    it("handles conflict with keep_remote: returns remote content for client to save", async () => {
      await env.BUCKET.put("notes/c.md", "remote wins", {
        customMetadata: { lastModified: "2026-05-12T10:00:00Z" },
      });

      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [],
          downloads: [],
          delete_remote: [],
          conflicts: [
            {
              key: "notes/c.md",
              conflict_key: "notes/c.sync-conflict-x.md",
              resolution: "keep_remote",
            },
          ],
          new_state: { files: {}, last_sync: "2026-05-12T12:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = await jsonBody<{ downloads: { key: string; content_base64: string }[] }>(res);
      expect(body.downloads).toHaveLength(1);
      expect(body.downloads[0].key).toBe("notes/c.md");
      expect(b64Decode(body.downloads[0].content_base64)).toBe("remote wins");
    });

    it("rejects unsafe keys (path traversal)", async () => {
      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [{ key: "../etc/passwd", content_base64: b64("evil"), last_modified: "x" }],
          downloads: [],
          delete_remote: [],
          conflicts: [],
          new_state: { files: {}, last_sync: "2026-05-12T12:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
    });

    it("rejects _sync-state/ prefix", async () => {
      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [{ key: "_sync-state/evil.json", content_base64: b64("x"), last_modified: "x" }],
          downloads: [],
          delete_remote: [],
          conflicts: [],
          new_state: { files: {}, last_sync: "2026-05-12T12:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
    });

    it("returns 409 on etag mismatch", async () => {
      // First write
      const req1 = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [],
          downloads: [],
          delete_remote: [],
          conflicts: [],
          new_state: { files: {}, last_sync: "2026-05-12T10:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx1 = createExecutionContext();
      await worker.fetch(req1, env, ctx1);
      await waitOnExecutionContext(ctx1);

      // Second write with stale etag (null when state exists)
      const req2 = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uploads: [],
          downloads: [],
          delete_remote: [],
          conflicts: [],
          new_state: { files: {}, last_sync: "2026-05-12T11:00:00Z" },
          expected_etag: null,
        }),
      });
      const ctx2 = createExecutionContext();
      const res2 = await worker.fetch(req2, env, ctx2);
      await waitOnExecutionContext(ctx2);

      expect(res2.status).toBe(409);
    });

    it("rejects invalid JSON", async () => {
      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
    });

    it("rejects missing required fields", async () => {
      const req = request("/sync/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploads: [] }),
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
    });
  });

  describe("Unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const req = request("/unknown");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
    });
  });
});
