import { SignJWT, jwtVerify } from "jose";
import { deriveState, executeBulk, isValidHash, loadSyncState, saveSyncState } from "./sync";
import type { BulkRequest, BulkResponse } from "./sync";

export interface Env {
  BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JWT_SECRET: string;
  JWT_EXPIRY_SECONDS?: string;
}

interface JwtPayload {
  sub: string;
  email: string;
  exp: number;
}

interface GoogleTokenResponse {
  access_token: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
}

const DEFAULT_JWT_EXPIRY_SECONDS = 259_200; // 3 days

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

async function handleSyncState(bucket: R2Bucket, userId: string): Promise<Response> {
  const { state, etag } = await loadSyncState(bucket, userId);
  return jsonResponse({ ...state, etag });
}

// 不正なタイムスタンプを保存すると、それを読んだ全クライアントで
// そのファイルが sync 対象から静かに消える
function isInvalidTimestamp(value: unknown): boolean {
  return typeof value !== "string" || Number.isNaN(Date.parse(value));
}

/**
 * リクエストの形をここで弾いておかないと、壊れた値が新しい同期状態に
 * そのまま焼き込まれ、全端末に伝播する。
 */
function validateBulkRequest(body: BulkRequest): string | null {
  if (
    !Array.isArray(body.uploads) ||
    !Array.isArray(body.downloads) ||
    !Array.isArray(body.delete_remote) ||
    !Array.isArray(body.conflicts)
  ) {
    return "Invalid request: missing or malformed fields";
  }
  if (body.downloads.some((k) => typeof k !== "string")) {
    return "Invalid download key";
  }
  if (body.delete_remote.some((k) => typeof k !== "string")) {
    return "Invalid delete key";
  }
  for (const u of body.uploads) {
    if (typeof u?.key !== "string" || typeof u.content_base64 !== "string") {
      return "Invalid upload entry";
    }
    if (isInvalidTimestamp(u.last_modified)) {
      return "Invalid last_modified timestamp";
    }
    if (!isValidHash(u.hash)) {
      return `Invalid content hash for ${u.key}`;
    }
  }
  for (const c of body.conflicts) {
    if (
      typeof c?.key !== "string" ||
      typeof c.conflict_key !== "string" ||
      typeof c.content_base64 !== "string"
    ) {
      return "Invalid conflict entry";
    }
    if (isInvalidTimestamp(c.last_modified)) {
      return "Invalid last_modified timestamp";
    }
    if (!isValidHash(c.hash)) {
      return `Invalid content hash for ${c.key}`;
    }
  }
  return null;
}

/**
 * 1 リクエストで引き受ける R2 操作の上限。
 *
 * Workers の Free プランは 1 呼び出しにつきサブリクエスト 50 回までで、
 * R2 バインディングの get / put / delete もそこに数えられる。bulk は
 * 1 ファイル 1 回(競合だけは退避の get + put と上書きの put で 3 回)、
 * 加えて同期状態の読み書きで必ず 2 回使う。
 *
 * クライアントは 40 で切っている(core の `BULK_OPERATION_BUDGET`)。
 * ここで断るのは分割を知らない古いクライアントで、そのとき返るのが
 * Cloudflare の `Too many subrequests` ではなく読める理由になる。
 */
const MAX_BULK_OPERATIONS = 45;

function bulkOperationCount(body: BulkRequest): number {
  return (
    body.uploads.length +
    body.downloads.length +
    body.conflicts.length * 3 +
    (body.delete_remote.length > 0 ? 1 : 0)
  );
}

async function handleSyncBulk(
  bucket: R2Bucket,
  userId: string,
  request: Request,
): Promise<Response> {
  let body: BulkRequest;
  try {
    body = (await request.json()) as BulkRequest;
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  const invalid = validateBulkRequest(body);
  if (invalid) {
    return errorResponse(invalid, 400);
  }
  const operations = bulkOperationCount(body);
  if (operations > MAX_BULK_OPERATIONS) {
    return errorResponse(
      `Too many operations for one request (${operations} > ${MAX_BULK_OPERATIONS}); split the sync`,
      413,
    );
  }

  // CAS check
  const { state: currentState, etag: currentEtag } = await loadSyncState(bucket, userId);
  if (currentEtag !== body.expected_etag) {
    return errorResponse("Sync state changed concurrently, please retry", 409);
  }

  let outcome;
  try {
    outcome = await executeBulk(bucket, body);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Bulk execution failed: ${msg}`, 400);
  }

  const newState = deriveState(currentState, body, Date.now());
  const saved = await saveSyncState(bucket, userId, newState, body.expected_etag);
  if (!saved) {
    return errorResponse("Sync state changed concurrently, please retry", 409);
  }

  const response: BulkResponse = { ...outcome, new_state: newState };
  return jsonResponse(response);
}

/**
 * 発行者と宛先。`jwtVerify` は既定では iss も aud も見ないので、名前を
 * 決めて両端で突き合わせる。同じ秘密鍵を別の用途にも使ってしまったとき、
 * そちらのトークンがこの Worker を素通りするのを防ぐ。
 */
const JWT_ISSUER = "magical-merchant-sync";
const JWT_AUDIENCE = "magical-merchant-app";

function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(payload.sub)
    .setExpirationTime(payload.exp)
    .sign(key);
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret);
    // AIDEV-NOTE: algorithms は必ず絞る。ヘッダの alg を信じると、署名方式の選択が相手の手に残る
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    return { sub: payload.sub, email: payload.email, exp: payload.exp };
  } catch {
    return null;
  }
}

function generateState(): string {
  return crypto.randomUUID();
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) {
    return null;
  }
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, "u"));
  return match ? match[1] : null;
}

/**
 * `app_redirect` は認証のあと JWT を載せて送り返す先。ここを緩めると、
 * リンクを踏ませるだけで 3 日有効のトークンが第三者の URL に渡る。
 *
 * 通すのはアプリが実際に送る 2 つの形だけ — deep link の
 * `magical-merchant://…` と、ループバックの `http://127.0.0.1:<port>/…`。
 *
 * AIDEV-NOTE: 文字列の前方一致では不十分。`http://127.0.0.1:1@evil.example/` は host が evil.example で userinfo が 127.0.0.1
 */
function parseAppRedirect(redirect: string): URL | null {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return null;
  }
  if (url.protocol === "magical-merchant:") {
    return url;
  }
  const loopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.username === "" &&
    url.password === "";
  return loopback ? url : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Android Chrome はユーザー操作を伴わないカスタムスキームへの遷移を捨てる。
 * 自動遷移だけだとアプリに戻れないので、必ずタップできるリンクを残す。
 */
export function deepLinkPage(redirectUrl: string): string {
  const href = escapeHtml(redirectUrl);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Magical Merchant</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; display: grid; place-items: center;
       min-height: 100dvh; margin: 0; gap: 1.5rem; text-align: center; padding: 1rem; }
a.open { display: inline-block; padding: .9rem 1.6rem; border-radius: .6rem;
         background: #4c6ef5; color: #fff; text-decoration: none; font-weight: 600; }
p { margin: 0; opacity: .75; }
</style>
</head>
<body>
<p>ログインが完了しました。</p>
<a id="open" class="open" href="${href}">アプリを開く</a>
<script>
  // 自動遷移が許可される環境（デスクトップ等）ではワンタップを省く。
  // URL は href から読む。スクリプトに URL を埋め込むと閉じタグで抜け出される
  location.href = document.getElementById("open").href;
</script>
</body>
</html>`;
}

function getJwtExpiry(env: Env): number {
  if (env.JWT_EXPIRY_SECONDS) {
    const parsed = parseInt(env.JWT_EXPIRY_SECONDS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_JWT_EXPIRY_SECONDS;
}

/** OAuth の入口: Google の同意画面へ 302 で送り出す。 */
function handleAuthGoogle(url: URL, env: Env): Response {
  const state = generateState();
  const appRedirect = url.searchParams.get("app_redirect") ?? "magical-merchant://auth/callback";
  if (!parseAppRedirect(appRedirect)) {
    return errorResponse("Invalid app_redirect", 400);
  }
  const redirectUri = `${url.origin}/auth/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    access_type: "offline",
  });
  return new Response(null, {
    status: 302,
    headers: new Headers([
      ["Location", `https://accounts.google.com/o/oauth2/v2/auth?${params}`],
      [
        "Set-Cookie",
        `__oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/callback`,
      ],
      [
        "Set-Cookie",
        `__oauth_app_redirect=${encodeURIComponent(appRedirect)}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/auth/callback`,
      ],
    ]),
  });
}

/** OAuth の出口: code をトークンに換え、JWT を発行してアプリへ戻す。 */
async function handleAuthCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  if (!code) {
    return errorResponse("Missing authorization code", 400);
  }

  const stateParam = url.searchParams.get("state");
  const stateCookie = getCookie(request, "__oauth_state");
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return errorResponse("Invalid state parameter", 403);
  }

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResp.ok) {
    return errorResponse("Failed to exchange authorization code", 502);
  }

  const tokenData = (await tokenResp.json()) as GoogleTokenResponse;
  if (!tokenData.access_token) {
    return errorResponse("Missing access token in Google response", 502);
  }

  const userinfoResp = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userinfoResp.ok) {
    return errorResponse("Failed to fetch user info", 502);
  }

  const userinfo = (await userinfoResp.json()) as GoogleUserInfo;
  if (!userinfo.sub || !userinfo.email) {
    return errorResponse("Missing user info in Google response", 502);
  }

  const expiry = getJwtExpiry(env);
  const jwt = await signJwt(
    {
      sub: userinfo.sub,
      email: userinfo.email,
      exp: Math.floor(Date.now() / 1000) + expiry,
    },
    env.JWT_SECRET,
  );

  const appRedirectCookie = getCookie(request, "__oauth_app_redirect");
  let appRedirect: string;
  try {
    appRedirect = appRedirectCookie
      ? decodeURIComponent(appRedirectCookie)
      : "magical-merchant://auth/callback";
  } catch {
    // 不正な %-エンコーディングで例外 → 500 になるのを防ぐ
    return errorResponse("Invalid redirect", 400);
  }
  // 入口で通した値が cookie 経由で戻るだけだが、ここでも見る。cookie を
  // 直に差し替えられたら、その一手でトークンの宛先が変わってしまう
  const parsedRedirect = parseAppRedirect(appRedirect);
  if (!parsedRedirect) {
    return errorResponse("Invalid redirect", 400);
  }
  const separator = appRedirect.includes("?") ? "&" : "?";
  const redirectUrl = `${appRedirect}${separator}token=${encodeURIComponent(jwt)}`;

  const clearCookies = new Headers([
    ["Content-Type", "text/html; charset=utf-8"],
    [
      "Set-Cookie",
      `__oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth/callback`,
    ],
    [
      "Set-Cookie",
      `__oauth_app_redirect=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/auth/callback`,
    ],
  ]);

  // Loopback redirects use 302, deep links use JS redirect
  if (parsedRedirect.protocol === "http:") {
    clearCookies.set("Location", redirectUrl);
    return new Response(null, { status: 302, headers: clearCookies });
  }

  return new Response(deepLinkPage(redirectUrl), { status: 200, headers: clearCookies });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (pathname === "/auth/google" && method === "GET") {
      return handleAuthGoogle(url, env);
    }

    if (pathname === "/auth/callback" && method === "GET") {
      return handleAuthCallback(request, url, env);
    }

    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return errorResponse("Unauthorized", 401);
    }

    const claims = await verifyJwt(token, env.JWT_SECRET);
    if (!claims) {
      return errorResponse("Unauthorized", 401);
    }

    if (pathname === "/sync-state" && method === "GET") {
      return handleSyncState(env.BUCKET, claims.sub);
    }

    if (pathname === "/sync/bulk" && method === "POST") {
      return handleSyncBulk(env.BUCKET, claims.sub, request);
    }

    return errorResponse("Not found", 404);
  },
} satisfies ExportedHandler<Env>;
