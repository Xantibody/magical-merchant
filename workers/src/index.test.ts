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

/// テスト用のダミーハッシュ。Worker は 64 桁小文字 hex しか受け付けない
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

/** Google の 2 往復 (code → access token → userinfo) を差し替える。 */
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

/** 入口を通った直後の状態、つまり state と app_redirect の cookie を持った戻り。 */
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

// リダイレクト先を検証し損ねると、リンクを踏ませるだけで 3 日有効の JWT が
// 第三者の URL へ 302 で渡る。/auth/* はここまでテストが 1 本も無かった
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

    // `http://127.0.0.1:1@evil.example/` の host は evil.example、127.0.0.1 は
    // userinfo。前方一致で見ていたころはこれが素通りしていた
    it.each([
      "http://127.0.0.1:1@evil.example/",
      "http://127.0.0.1.evil.example/callback",
      "http://evil.example/callback",
      "https://127.0.0.1:1421/callback",
      "http://localhost:1421/callback",
      "magical-merchant-evil://auth/callback",
      "not a url",
      "",
    ])("refuses app_redirect %o", async (appRedirect) => {
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

    // 発行側と検証側で iss / aud がずれると、ログインは通るのに最初の
    // 同期が 401 で返る。往復させて 1 本で押さえる
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

    // cookie を差し替えられても宛先は変えさせない。入口で通した値でも、
    // 出口でもう一度見るのはそのため
    it.each(["http://127.0.0.1:1@evil.example/", "http://evil.example/callback"])(
      "refuses to send the token to %o",
      async (appRedirect) => {
        stubGoogle();

        const res = await authCallback(appRedirect);

        expect(res.status).toBe(400);
        expect(res.headers.get("Location")).toBeNull();
      },
    );

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

    // 署名方式・発行者・宛先は発行側が決めるもの。検証側が「トークンに
    // 書いてある通り」で受けると、その選択が持ち込む側の手に残る
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

    // 2台目がダウンロードしただけで state からファイルが消えると、
    // 次の同期で全端末が「リモートで削除された」と解釈してノートを消してしまう
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
      // ダウンロードは版を進めない。進めると同期済みの端末が再取得し続ける
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

      // ローカルが勝つ
      await expect(objectText(await env.BUCKET.get("notes/c.md"))).resolves.toBe("local version");
      // 上書きされたリモート側は R2 に退避され、クライアントにも返る
      await expect(
        objectText(await env.BUCKET.get("notes/c.sync-conflict-20260512-120000.md")),
      ).resolves.toBe("remote version");
      expect(body.conflict_downloads).toHaveLength(1);
      expect(b64Decode(body.conflict_downloads[0].content_base64)).toBe("remote version");
      // 競合コピーは同期対象外。state に載せると全端末が延々と取得し続ける
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

      // 2 回目が stale な etag (state があるのに null) を送る
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

    // 壊れたハッシュを state に入れると、全端末で変更検出が壊れる
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

    // Free プランは 1 呼び出し 50 サブリクエストで、bulk は R2 を 1 ファイル
    // 1 回叩く。超えると Cloudflare が落とすので、その手前で理由を返す
    it("refuses a bulk over the operation limit", async () => {
      const res = await bulk({ uploads: uploads(46) });

      expect(res.status).toBe(413);
      const body = await jsonBody<{ error: string }>(res);
      expect(body.error).toContain("split the sync");
    });

    // 競合は退避の get + put と上書きの put で 3 回。1 と数えると、
    // 通した bulk が上限の 3 倍を使う
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

  // R2 のキーはユーザー別に分かれていない。2 人目が入ると同じ
  // `notes/<id>.md` を取り合い、両者の state が延々と押し合う
  describe("the ALLOWED_SUBS allowlist", () => {
    it("lets anyone in while it is unset", async () => {
      const res = await send(request("/sync-state"), { ALLOWED_SUBS: "" });

      expect(res.status).toBe(200);
    });

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

// Android Chrome はユーザー操作なしのカスタムスキーム遷移を捨てるため、
// 自動遷移だけだとアプリに戻れない (#59)
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
