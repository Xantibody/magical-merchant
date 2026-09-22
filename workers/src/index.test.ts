import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import worker, { deepLinkPage } from "./index";

interface JwtOptions {
  sub: string;
  email: string;
  exp: number;
  alg?: string;
  issuer?: string;
  audience?: string;
}

function makeJwt(payload: JwtOptions, secret = env.JWT_SECRET): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: payload.alg ?? "HS256" })
    .setIssuer(payload.issuer ?? "magical-merchant-sync")
    .setAudience(payload.audience ?? "magical-merchant-app")
    .setSubject(payload.sub)
    .setExpirationTime(payload.exp)
    .sign(key);
}

let validToken: string;

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

async function send(req: Request, overrides: Partial<typeof env> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function jsonBody<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function objectText(object: R2ObjectBody | null): Promise<string> {
  if (!object) {
    throw new Error("expected the object to exist in R2");
  }
  return object.text();
}

function b64(s: string): string {
  return btoa(s);
}

function b64Decode(s: string): string {
  return atob(s);
}

/// A dummy hash for the tests. The Worker accepts only 64 lowercase hex digits
function hash(seed: string): string {
  return seed
    .repeat(64)
    .slice(0, 64)
    .replaceAll(/[^0-9a-f]/gu, "a");
}

interface FileContent {
  key: string;
  content_base64: string;
  last_modified: string;
}

interface SyncStateBody {
  files: Record<string, { hash: string; last_modified: string }>;
  last_sync: string | null;
  etag: string | null;
}

interface BulkBody {
  downloads: FileContent[];
  conflict_downloads: FileContent[];
  new_state: SyncStateBody;
}

type BulkInput = Partial<{
  uploads: unknown[];
  downloads: unknown[];
  delete_remote: unknown[];
  conflicts: unknown[];
  expected_etag: string | null;
}>;

function bulk(body: BulkInput): Promise<Response> {
  return send(
    request("/sync/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploads: [],
        downloads: [],
        delete_remote: [],
        conflicts: [],
        expected_etag: null,
        ...body,
      }),
    }),
  );
}

function upload(key: string, content: string, seed = "b"): Record<string, string> {
  return {
    key,
    content_base64: b64(content),
    last_modified: "2026-05-12T10:00:00Z",
    hash: hash(seed),
  };
}

async function currentState(): Promise<SyncStateBody> {
  return jsonBody<SyncStateBody>(await send(request("/sync-state")));
}

async function clearBucket(): Promise<void> {
  const listed = await env.BUCKET.list({ limit: 1000 });
  if (listed.objects.length > 0) {
    await env.BUCKET.delete(listed.objects.map((o) => o.key));
  }
}

/** Replaces Google's two round trips: the code for an access token, then userinfo. */
function stubGoogle(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<Response> => {
    const target = input instanceof Request ? input.url : String(input);
    if (target.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(Response.json({ access_token: "google-access-token" }));
    }
    if (target.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return Promise.resolve(Response.json({ sub: "user-123", email: "test@example.com" }));
    }
    throw new Error(`unexpected fetch to ${target}`);
  });
}

function authGoogle(appRedirect: string): Promise<Response> {
  const query = `?app_redirect=${encodeURIComponent(appRedirect)}`;
  return send(new Request(`http://localhost/auth/google${query}`));
}

/** The return right after the entrance, carrying the state and app_redirect cookies. */
function authCallback(appRedirect: string): Promise<Response> {
  const cookie = [
    "__oauth_state=state-abc",
    `__oauth_app_redirect=${encodeURIComponent(appRedirect)}`,
  ].join("; ");
  return send(
    new Request("http://localhost/auth/callback?code=auth-code&state=state-abc", {
      headers: { Cookie: cookie },
    }),
  );
}

const LOOPBACK_REDIRECT = "http://127.0.0.1:1421/callback/1f0c1b5e";

// Fail to validate the redirect target and one link is enough to hand a JWT valid for
// 3 days to a third party's URL with a 302. `/auth/*` had no test at all until now
describe("OAuth entry and exit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("gET /auth/google", () => {
    it("sends a loopback redirect on to Google", async () => {
      const res = await authGoogle(LOOPBACK_REDIRECT);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("accounts.google.com");
    });

    it("sends a deep link redirect on to Google", async () => {
      const res = await authGoogle("magical-merchant://auth/callback");

      expect(res.status).toBe(302);
    });

    // The host of `http://127.0.0.1:1@evil.example/` is evil.example and 127.0.0.1 is
    // the userinfo. Back when this was a prefix match it went straight through
    it.each([
      "http://127.0.0.1:1@evil.example/",
      "http://127.0.0.1.evil.example/callback",
      "http://evil.example/callback",
      "https://127.0.0.1:1421/callback",
      "http://localhost:1421/callback",
      "magical-merchant-evil://auth/callback",
      "not a url",
      "",
      // `?token=` is appended at the end for the loopback too. With a query or a
      // fragment already there, the listener gets not one character of the token
      `${LOOPBACK_REDIRECT}?next=evil`,
      `${LOOPBACK_REDIRECT}#`,
    ])("refuses app_redirect %o", async (appRedirect) => {
      const res = await authGoogle(appRedirect);

      expect(res.status).toBe(400);
    });

    // The hosts the Android intent-filter assigns to the real app are `auth` and
    // `widget` only. Back when only the scheme was looked at, a malicious app that
    // registered another host was delivered the whole `?token=`
    it.each([
      "magical-merchant://steal/callback",
      "magical-merchant://widget/new-note",
      "magical-merchant://auth@evil.example/callback",
      "magical-merchant://auth/callback/../steal",
      "magical-merchant://auth/steal",
      "magical-merchant://auth/",
      "magical-merchant://auth",
      "magical-merchant:auth/callback",
      "magical-merchant://AUTH/callback",
      // If a query could be added, the return URL would not end before `?token=`
      "magical-merchant://auth/callback?next=evil",
      // With a fragment, `?token=` goes behind it and never reaches the app. An empty
      // fragment and an empty query slipped past a list of conditions, because URL
      // parsing reports hash / search as ""
      "magical-merchant://auth/callback#frag",
      "magical-merchant://auth/callback#",
      "magical-merchant://auth/callback?",
    ])("refuses the deep link %o", async (appRedirect) => {
      const res = await authGoogle(appRedirect);

      expect(res.status).toBe(400);
    });
  });

  describe("gET /auth/callback", () => {
    it("hands the token to the loopback listener", async () => {
      stubGoogle();

      const res = await authCallback(LOOPBACK_REDIRECT);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain(`${LOOPBACK_REDIRECT}?token=`);
    });

    // If `iss` / `aud` drift apart between the issuing side and the verifying side,
    // sign-in works but the first sync comes back 401. One round trip pins it down
    it("issues a token the sync routes accept", async () => {
      stubGoogle();
      const callback = await authCallback(LOOPBACK_REDIRECT);
      const location = callback.headers.get("Location");
      vi.unstubAllGlobals();
      const issued = new URL(String(location)).searchParams.get("token");

      const res = await send(
        new Request("http://localhost/sync-state", {
          headers: { Authorization: `Bearer ${issued}` },
        }),
      );

      expect(res.status).toBe(200);
    });

    it("hands the token to the deep link as a tappable page", async () => {
      stubGoogle();

      const res = await authCallback("magical-merchant://auth/callback");

      expect(res.status).toBe(200);
      await expect(res.text()).resolves.toContain("magical-merchant://auth/callback?token=");
    });

    // The destination must not change even if the cookie is swapped. That is why a
    // value passed at the entrance is looked at again at the exit
    it.each([
      "http://127.0.0.1:1@evil.example/",
      "http://evil.example/callback",
      "magical-merchant://steal/callback",
      // Let this through and the link in the returned HTML becomes `.../callback#?token=`
      "magical-merchant://auth/callback#",
    ])("refuses to send the token to %o", async (appRedirect) => {
      stubGoogle();

      const res = await authCallback(appRedirect);

      expect(res.status).toBe(400);
      expect(res.headers.get("Location")).toBeNull();
    });

    it("refuses a callback whose state does not match the cookie", async () => {
      stubGoogle();

      const res = await send(
        new Request("http://localhost/auth/callback?code=auth-code&state=forged", {
          headers: { Cookie: "__oauth_state=state-abc" },
        }),
      );

      expect(res.status).toBe(403);
    });
  });
});

describe("Workers Sync API", () => {
  beforeAll(async () => {
    validToken = await makeJwt({
      sub: "user-123",
      email: "test@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });

  afterEach(async () => {
    await clearBucket();
  });

  describe("authentication", () => {
    it("rejects requests without Authorization header", async () => {
      const res = await send(new Request("http://localhost/sync-state"));
      expect(res.status).toBe(401);
    });

    it("rejects invalid JWT", async () => {
      const res = await send(
        new Request("http://localhost/sync-state", {
          headers: { Authorization: "Bearer invalid" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("rejects expired JWT", async () => {
      const expiredToken = await makeJwt({
        sub: "user-123",
        email: "test@example.com",
        exp: Math.floor(Date.now() / 1000) - 100,
      });
      const res = await send(
        new Request("http://localhost/sync-state", {
          headers: { Authorization: `Bearer ${expiredToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    // The signature scheme, the issuer and the audience are the issuing side's to
    // decide. If the verifying side takes them "as written in the token", that choice
    // stays in the hands of whoever brings the token
    it.each([
      { name: "another algorithm", claims: { alg: "HS512" } },
      { name: "another issuer", claims: { issuer: "https://evil.example" } },
      { name: "another audience", claims: { audience: "somebody-else" } },
    ])("rejects a JWT signed for $name", async ({ claims }) => {
      const token = await makeJwt({
        sub: "user-123",
        email: "test@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
      });

      const res = await send(
        new Request("http://localhost/sync-state", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );

      expect(res.status).toBe(401);
    });
  });

  describe("gET /sync-state", () => {
    it("returns empty state for new user", async () => {
      const body = await currentState();
      expect(body.files).toStrictEqual({});
      expect(body.last_sync).toBeNull();
      expect(body.etag).toBeNull();
    });

    it("returns saved state with etag", async () => {
      const uploaded = await bulk({ uploads: [upload("notes/a.md", "hello", "b")] });
      expect(uploaded.status).toBe(200);

      const state = await currentState();
      expect(state.files["notes/a.md"].hash).toBe(hash("b"));
      expect(state.etag?.length).toBeGreaterThan(0);
    });
  });

  describe("pOST /sync/bulk", () => {
    it("uploads files to R2", async () => {
      const res = await bulk({ uploads: [upload("notes/up.md", "uploaded content")] });

      expect(res.status).toBe(200);
      await expect(objectText(await env.BUCKET.get("notes/up.md"))).resolves.toBe(
        "uploaded content",
      );
    });

    it("records uploads in the server-owned state", async () => {
      const res = await bulk({ uploads: [upload("notes/up.md", "content", "c")] });

      const body = await jsonBody<BulkBody>(res);
      expect(body.new_state.files["notes/up.md"].hash).toBe(hash("c"));
      expect(body.new_state.last_sync).not.toBeNull();
    });

    it("downloads files from R2", async () => {
      await env.BUCKET.put("notes/down.md", "remote content", {
        customMetadata: { lastModified: "2026-05-12T11:00:00Z" },
      });

      const res = await bulk({ downloads: ["notes/down.md"] });

      expect(res.status).toBe(200);
      const body = await jsonBody<BulkBody>(res);
      expect(body.downloads).toHaveLength(1);
      expect(body.downloads[0].key).toBe("notes/down.md");
      expect(b64Decode(body.downloads[0].content_base64)).toBe("remote content");
    });

    // If a file dropped out of the state just because a second device downloaded it,
    // every device would read "deleted remotely" on the next sync and erase the note
    it("keeps downloaded files in the state so a second device cannot wipe it", async () => {
      await bulk({ uploads: [upload("notes/a.md", "from device A", "d")] });
      const afterUpload = await currentState();

      const res = await bulk({
        downloads: ["notes/a.md"],
        expected_etag: afterUpload.etag,
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<BulkBody>(res);
      expect(Object.keys(body.new_state.files)).toStrictEqual(["notes/a.md"]);
      expect(body.new_state.files["notes/a.md"].hash).toBe(hash("d"));
      // A download does not advance the version. If it did, devices already in sync
      // would keep fetching it again
      expect(body.new_state.files["notes/a.md"].last_modified).toBe(
        afterUpload.files["notes/a.md"].last_modified,
      );
    });

    it("deletes remote files and drops them from the state", async () => {
      await bulk({ uploads: [upload("notes/del.md", "to delete")] });
      const afterUpload = await currentState();

      const res = await bulk({
        delete_remote: ["notes/del.md"],
        expected_etag: afterUpload.etag,
      });

      expect(res.status).toBe(200);
      await expect(env.BUCKET.get("notes/del.md")).resolves.toBeNull();
      const body = await jsonBody<BulkBody>(res);
      expect(body.new_state.files).toStrictEqual({});
    });

    it("advances the version stamp when the same file is uploaded again", async () => {
      await bulk({ uploads: [upload("notes/a.md", "v1", "a")] });
      const first = await currentState();

      await bulk({
        uploads: [upload("notes/a.md", "v2", "b")],
        expected_etag: first.etag,
      });
      const second = await currentState();

      expect(second.files["notes/a.md"].last_modified).not.toBe(
        first.files["notes/a.md"].last_modified,
      );
    });

    it("resolves conflicts by keeping local and handing the remote copy back", async () => {
      await env.BUCKET.put("notes/c.md", "remote version", {
        customMetadata: { lastModified: "2026-05-12T10:00:00Z" },
      });

      const res = await bulk({
        conflicts: [
          {
            key: "notes/c.md",
            conflict_key: "notes/c.sync-conflict-20260512-120000.md",
            content_base64: b64("local version"),
            hash: hash("e"),
            last_modified: "2026-05-12T12:00:00Z",
          },
        ],
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<BulkBody>(res);

      // The local copy wins
      await expect(objectText(await env.BUCKET.get("notes/c.md"))).resolves.toBe("local version");
      // The overwritten remote side is stashed in R2 and returned to the client too
      await expect(
        objectText(await env.BUCKET.get("notes/c.sync-conflict-20260512-120000.md")),
      ).resolves.toBe("remote version");
      expect(body.conflict_downloads).toHaveLength(1);
      expect(b64Decode(body.conflict_downloads[0].content_base64)).toBe("remote version");
      // A conflict copy is not synced. Put it in the state and every device keeps
      // fetching it forever
      expect(Object.keys(body.new_state.files)).toStrictEqual(["notes/c.md"]);
    });

    it("rejects unsafe keys (path traversal)", async () => {
      const res = await bulk({ uploads: [upload("../etc/passwd", "evil")] });
      expect(res.status).toBe(400);
    });

    it("rejects _sync-state/ prefix", async () => {
      const res = await bulk({ uploads: [upload("_sync-state/evil.json", "x")] });
      expect(res.status).toBe(400);
    });

    it("returns 409 on etag mismatch", async () => {
      await bulk({ uploads: [upload("notes/a.md", "first")] });

      // The second call sends a stale etag (null although there is a state)
      const res = await bulk({ uploads: [upload("notes/b.md", "second")] });

      expect(res.status).toBe(409);
    });

    it("rejects invalid JSON", async () => {
      const res = await send(
        request("/sync/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        }),
      );
      expect(res.status).toBe(400);
    });

    // `null` and `1` are both valid JSON. Going on to read a body that is not an object
    // throws, and Cloudflare's HTML 500 comes back
    it.each(["null", "1", '"a string"'])(
      "rejects a body that is not an object: %s",
      async (body) => {
        const res = await send(
          request("/sync/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        );

        expect(res.status).toBe(400);
        expect(res.headers.get("Content-Type")).toContain("application/json");
      },
    );

    it("rejects missing required fields", async () => {
      const res = await send(
        request("/sync/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploads: [] }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("rejects an upload with an unparsable last_modified", async () => {
      const res = await bulk({
        uploads: [{ ...upload("notes/bad.md", "content"), last_modified: "not-a-date" }],
      });
      expect(res.status).toBe(400);
    });

    // A broken hash in the state breaks change detection on every device
    it("rejects an upload whose hash is not a sha256 hex digest", async () => {
      const res = await bulk({
        uploads: [{ ...upload("notes/bad.md", "content"), hash: "abc" }],
      });
      expect(res.status).toBe(400);
    });

    function uploads(count: number): Record<string, string>[] {
      return Array.from({ length: count }, (_, i) => upload(`notes/${i}.md`, `body ${i}`));
    }

    it("accepts a bulk at the operation limit", async () => {
      const res = await bulk({ uploads: uploads(45) });
      expect(res.status).toBe(200);
    });

    // The Free plan gives 50 subrequests per invocation, and a bulk hits R2 once per
    // file. Over that Cloudflare drops it, so the reason is returned just short of it
    it("refuses a bulk over the operation limit", async () => {
      const res = await bulk({ uploads: uploads(46) });

      expect(res.status).toBe(413);
      const body = await jsonBody<{ error: string }>(res);
      expect(body.error).toContain("split the sync");
    });

    // A conflict is three: the get and put that stash the copy, plus the put that
    // overwrites. Count it as one and a bulk that gets through uses three times the cap
    it("counts a conflict as three operations", async () => {
      const conflicts = Array.from({ length: 16 }, (_, i) => ({
        key: `notes/${i}.md`,
        conflict_key: `notes/${i}.sync-conflict.md`,
        content_base64: b64("mine"),
        last_modified: "2026-05-12T10:00:00Z",
        hash: hash("c"),
      }));

      const res = await bulk({ conflicts });

      expect(res.status).toBe(413);
    });
  });

  // R2 keys are not split per user. Let a second person in and they fight over the same
  // `notes/<id>.md`, with the two states shoving each other forever
  describe("the ALLOWED_SUBS allowlist", () => {
    it("lets anyone in while it is unset", async () => {
      const res = await send(request("/sync-state"), { ALLOWED_SUBS: undefined });

      expect(res.status).toBe(200);
    });

    // Set but empty is a configuration failure. Read it as "unset" and the bucket opens
    // to anyone at the moment it was meant to be closed
    it.each(["", " ", ",", " , ", ",,"])(
      "refuses everyone when it is set to %o",
      async (allowedSubs) => {
        const res = await send(request("/sync-state"), { ALLOWED_SUBS: allowedSubs });

        expect(res.status).toBe(403);
      },
    );

    it("lets a listed sub in, ignoring the spaces around it", async () => {
      const res = await send(request("/sync-state"), { ALLOWED_SUBS: "somebody, user-123 " });

      expect(res.status).toBe(200);
    });

    it("refuses a sub that is not listed", async () => {
      const res = await send(request("/sync-state"), { ALLOWED_SUBS: "somebody-else" });

      expect(res.status).toBe(403);
    });

    it("refuses a bulk from a sub that is not listed", async () => {
      const res = await send(
        request("/sync/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploads: [upload("notes/a.md", "mine")],
            downloads: [],
            delete_remote: [],
            conflicts: [],
            expected_etag: null,
          }),
        }),
        { ALLOWED_SUBS: "somebody-else" },
      );

      expect(res.status).toBe(403);
      await expect(env.BUCKET.get("notes/a.md")).resolves.toBeNull();
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await send(request("/unknown"));
      expect(res.status).toBe(404);
    });
  });
});

// Android Chrome discards a navigation to a custom scheme with no user action behind
// it, so an automatic navigation alone cannot get back to the app (#59)
describe("deepLinkPage", () => {
  it("offers a tappable link to the app, not only an automatic redirect", () => {
    const html = deepLinkPage("magical-merchant://auth/callback?token=abc");
    expect(html).toContain('href="magical-merchant://auth/callback?token=abc"');
  });

  it("escapes a redirect that tries to break out of the script tag", () => {
    const html = deepLinkPage("magical-merchant://auth/callback?token=</script><script>evil()");
    expect(html).not.toContain("<script>evil()");
  });
});
