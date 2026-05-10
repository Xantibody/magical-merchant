import { env, createExecutionContext, waitOnExecutionContext, fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { SignJWT } from "jose";
import worker from "./index";

const TEST_SECRET = "test-jwt-secret-for-development-only";

async function makeJwt(
  payload: { sub: string; email: string; exp: number },
  secret = TEST_SECRET,
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

describe("Workers R2 Proxy", () => {
  describe("Authentication", () => {
    it("rejects requests without Authorization header", async () => {
      const req = new Request("http://localhost/files");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
      const body = await jsonBody<{ error: string }>(res);
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects requests with invalid JWT", async () => {
      const req = new Request("http://localhost/files", {
        headers: { Authorization: "Bearer invalid-token" },
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
      const req = new Request("http://localhost/files", {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
    });

    it("rejects JWT signed with wrong secret", async () => {
      const badToken = await makeJwt(
        {
          sub: "user-123",
          email: "test@example.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        "wrong-secret",
      );
      const req = new Request("http://localhost/files", {
        headers: { Authorization: `Bearer ${badToken}` },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(401);
    });

    it("accepts requests with valid Bearer token", async () => {
      const req = request("/files");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
    });
  });

  describe("GET /auth/google", () => {
    it("redirects to Google OAuth with state cookie", async () => {
      const req = new Request("http://localhost/auth/google");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
      expect(location).toContain("client_id=test-client-id");
      expect(location).toContain("scope=openid+email");
      expect(location).toContain("redirect_uri=http%3A%2F%2Flocalhost%2Fauth%2Fcallback");

      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.includes("__oauth_state="))).toBe(true);
    });

    it("stores app_redirect in cookie", async () => {
      const req = new Request(
        "http://localhost/auth/google?app_redirect=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback",
      );
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(302);
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.includes("__oauth_app_redirect="))).toBe(true);
    });
  });

  describe("GET /auth/callback", () => {
    beforeAll(() => {
      fetchMock.activate();
    });

    afterEach(() => {
      fetchMock.assertNoPendingInterceptors();
    });

    it("returns 400 when code is missing", async () => {
      const req = new Request("http://localhost/auth/callback");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
    });

    it("returns 403 when state does not match cookie", async () => {
      const req = new Request("http://localhost/auth/callback?code=test-code&state=abc", {
        headers: { Cookie: "__oauth_state=different-state" },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(403);
    });

    it("returns 403 when state cookie is missing", async () => {
      const req = new Request("http://localhost/auth/callback?code=test-code&state=abc");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(403);
    });

    it("exchanges code and redirects via deep link", async () => {
      fetchMock
        .get("https://oauth2.googleapis.com")
        .intercept({ path: "/token", method: "POST" })
        .reply(200, JSON.stringify({ access_token: "google-access-token" }), {
          headers: { "Content-Type": "application/json" },
        });

      fetchMock
        .get("https://openidconnect.googleapis.com")
        .intercept({ path: "/v1/userinfo" })
        .reply(200, JSON.stringify({ sub: "google-user-123", email: "user@gmail.com" }), {
          headers: { "Content-Type": "application/json" },
        });

      const req = new Request(
        "http://localhost/auth/callback?code=test-auth-code&state=valid-state",
        {
          headers: { Cookie: "__oauth_state=valid-state" },
        },
      );
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("magical-merchant://auth/callback?token=");
    });

    it("redirects via 302 for loopback app_redirect", async () => {
      fetchMock
        .get("https://oauth2.googleapis.com")
        .intercept({ path: "/token", method: "POST" })
        .reply(200, JSON.stringify({ access_token: "google-access-token" }), {
          headers: { "Content-Type": "application/json" },
        });

      fetchMock
        .get("https://openidconnect.googleapis.com")
        .intercept({ path: "/v1/userinfo" })
        .reply(200, JSON.stringify({ sub: "google-user-123", email: "user@gmail.com" }), {
          headers: { "Content-Type": "application/json" },
        });

      const appRedirect = encodeURIComponent("http://127.0.0.1:12345/callback");
      const req = new Request(
        "http://localhost/auth/callback?code=test-auth-code&state=valid-state",
        {
          headers: {
            Cookie: `__oauth_state=valid-state; __oauth_app_redirect=${appRedirect}`,
          },
        },
      );
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("http://127.0.0.1:12345/callback?token=");
    });

    it("returns 502 when token exchange fails", async () => {
      fetchMock
        .get("https://oauth2.googleapis.com")
        .intercept({ path: "/token", method: "POST" })
        .reply(400, JSON.stringify({ error: "invalid_grant" }));

      const req = new Request("http://localhost/auth/callback?code=bad-code&state=valid-state", {
        headers: { Cookie: "__oauth_state=valid-state" },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(502);
    });
  });

  describe("GET /files", () => {
    it("returns empty list when bucket is empty", async () => {
      const req = request("/files");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = await jsonBody<{ files: unknown[] }>(res);
      expect(body.files).toEqual([]);
    });

    it("lists uploaded files with metadata", async () => {
      const putReq = request("/files/notes/test.md", {
        method: "PUT",
        body: "hello",
        headers: { "X-Last-Modified": "2026-04-22T10:00:00Z" },
      });
      const putCtx = createExecutionContext();
      await worker.fetch(putReq, env, putCtx);
      await waitOnExecutionContext(putCtx);

      const req = request("/files");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        files: { key: string; lastModified: string; size: number }[];
      }>(res);
      expect(body.files).toHaveLength(1);
      expect(body.files[0].key).toBe("notes/test.md");
      expect(body.files[0].lastModified).toBe("2026-04-22T10:00:00Z");
      expect(body.files[0].size).toBe(5);
    });
  });

  describe("GET /files/:key", () => {
    it("returns file content and X-Last-Modified header", async () => {
      const putReq = request("/files/timeline/2026-04-22.md", {
        method: "PUT",
        body: "# Timeline",
        headers: { "X-Last-Modified": "2026-04-22T12:00:00Z" },
      });
      const putCtx = createExecutionContext();
      await worker.fetch(putReq, env, putCtx);
      await waitOnExecutionContext(putCtx);

      const req = request("/files/timeline/2026-04-22.md");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("# Timeline");
      expect(res.headers.get("X-Last-Modified")).toBe("2026-04-22T12:00:00Z");
    });

    it("returns 404 for missing file", async () => {
      const req = request("/files/missing.md");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /files/:key", () => {
    it("creates a new file with custom lastModified", async () => {
      const putReq = request("/files/notes/new.md", {
        method: "PUT",
        body: "# New Note",
        headers: { "X-Last-Modified": "2026-04-22T14:00:00Z" },
      });
      const putCtx = createExecutionContext();
      const putRes = await worker.fetch(putReq, env, putCtx);
      await waitOnExecutionContext(putCtx);
      expect(putRes.status).toBe(201);

      const getReq = request("/files/notes/new.md");
      const getCtx = createExecutionContext();
      const getRes = await worker.fetch(getReq, env, getCtx);
      await waitOnExecutionContext(getCtx);

      expect(getRes.status).toBe(200);
      expect(await getRes.text()).toBe("# New Note");
      expect(getRes.headers.get("X-Last-Modified")).toBe("2026-04-22T14:00:00Z");
    });

    it("uses current time if X-Last-Modified is missing", async () => {
      const putReq = request("/files/notes/auto.md", {
        method: "PUT",
        body: "content",
      });
      const putCtx = createExecutionContext();
      const putRes = await worker.fetch(putReq, env, putCtx);
      await waitOnExecutionContext(putCtx);
      expect(putRes.status).toBe(201);

      const body = await jsonBody<{ lastModified: string }>(putRes);
      expect(body.lastModified).toBeDefined();
    });
  });

  describe("DELETE /files/:key", () => {
    it("deletes an existing file", async () => {
      const putReq = request("/files/notes/delete-me.md", {
        method: "PUT",
        body: "bye",
        headers: { "X-Last-Modified": "2026-04-22T10:00:00Z" },
      });
      const putCtx = createExecutionContext();
      await worker.fetch(putReq, env, putCtx);
      await waitOnExecutionContext(putCtx);

      const delReq = request("/files/notes/delete-me.md", {
        method: "DELETE",
      });
      const delCtx = createExecutionContext();
      const delRes = await worker.fetch(delReq, env, delCtx);
      await waitOnExecutionContext(delCtx);
      expect(delRes.status).toBe(204);

      const getReq = request("/files/notes/delete-me.md");
      const getCtx = createExecutionContext();
      const getRes = await worker.fetch(getReq, env, getCtx);
      await waitOnExecutionContext(getCtx);
      expect(getRes.status).toBe(404);
    });

    it("returns 204 even for non-existent file", async () => {
      const req = request("/files/missing.md", { method: "DELETE" });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(204);
    });
  });

  describe("Security", () => {
    it("rejects path traversal with ..", async () => {
      const req = request("/files/notes/..%2Fsecret.md");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
      const body = await jsonBody<{ error: string }>(res);
      expect(body.error).toBe("Path traversal not allowed");
    });

    it("rejects empty key", async () => {
      const req = request("/files/");
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(400);
    });
  });

  describe("Method handling", () => {
    it("returns 405 for unsupported methods", async () => {
      const req = request("/files/test.md", { method: "PATCH" });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, env, ctx);
      await waitOnExecutionContext(ctx);

      expect(res.status).toBe(405);
    });
  });
});
