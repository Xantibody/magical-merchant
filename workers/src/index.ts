import { SignJWT, jwtVerify } from "jose";
import { deriveState, executeBulk, isValidHash, loadSyncState, saveSyncState } from "./sync";
import type { BulkRequest, BulkResponse } from "./sync";

export interface Env {
  BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JWT_SECRET: string;
  JWT_EXPIRY_SECONDS?: string;
  ALLOWED_SUBS?: string;
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

// Storing an invalid timestamp makes that file drop out of sync silently on every
// client that reads it
function isInvalidTimestamp(value: unknown): boolean {
  return typeof value !== "string" || Number.isNaN(Date.parse(value));
}

/**
 * Reject the shape of the request here, or broken values get burned into the new sync
 * state as they are and spread to every device.
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
 * The cap on R2 operations taken on in one request.
 *
 * The Workers Free plan allows 50 subrequests per invocation, and the R2 binding's
 * get / put / delete count towards that. A bulk takes one per file (a conflict alone
 * takes three: the get and put that stash the copy, plus the put that overwrites), and
 * always two more to read and write the sync state.
 *
 * The client cuts at 40 (core's `BULK_OPERATION_BUDGET`). What is refused here is an
 * older client that does not know about splitting, and what comes back then is a
 * readable reason rather than Cloudflare's `Too many subrequests`.
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
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  // `null` and `1` are both valid JSON. Reading the fields off them as they are throws,
  // and an unreadable HTML 500 comes back
  if (typeof parsed !== "object" || parsed === null) {
    return errorResponse("Invalid request: expected a JSON object", 400);
  }
  const body = parsed as BulkRequest;
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
 * Issuer and audience. `jwtVerify` looks at neither `iss` nor `aud` by default, so the
 * names are fixed and checked at both ends. If the same secret ever gets used for
 * another purpose, this keeps those tokens from walking straight through this Worker.
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
    // AIDEV-NOTE: always pin `algorithms`. Trusting the header's `alg` leaves the choice of signature scheme in the caller's hands
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

/**
 * One bucket = one person. Notes stay at `notes/<id>.md`, and the only thing split per
 * user is the sync state (`_sync-state/<sub>.json`), so if somebody else signs in to
 * the same Worker the two fight over the same keys forever.
 *
 * Listing Google `sub` values in `ALLOWED_SUBS`, comma separated, lets only those
 * people through. Only when the variable itself is absent does everyone get in as
 * before: an existing deployment is not shut out silently.
 *
 * AIDEV-NOTE: namespacing the keys under `${sub}/` was rejected because existing objects would have to be migrated. One bucket per person stands
 * AIDEV-NOTE: "set but empty" is closed off as a different thing from unset. Treating them alike would leave the bucket wide open on the misconfiguration meant to close it
 */
function isAllowedSub(allowedSubs: string | undefined, sub: string): boolean {
  if (allowedSubs === undefined) {
    return true;
  }
  // Drop empty entries. Kept, a token whose `sub` is the empty string matches `ALLOWED_SUBS=""`
  return allowedSubs
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(sub);
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
 * The only form a deep link may take as the return target of authentication. The
 * intent-filter in `tauri.conf.json` assigns only the two hosts `auth` and `widget` to
 * the real app, and authentication uses just `auth/callback` of those.
 */
const DEEP_LINK_PROTOCOL = "magical-merchant:";
const DEEP_LINK_REDIRECT = "magical-merchant://auth/callback";

/**
 * `app_redirect` is where the JWT is sent back after authentication. Loosen this and
 * one link is enough to hand a token valid for 3 days to a third party's URL.
 *
 * Only the two forms the app actually sends get through: the deep link
 * `magical-merchant://auth/callback` itself, and the loopback
 * `http://127.0.0.1:<port>/...`.
 *
 * AIDEV-NOTE: a string prefix match is not enough. `http://127.0.0.1:1@evil.example/` has host evil.example and userinfo 127.0.0.1
 * AIDEV-NOTE: a deep link cannot be narrowed by the scheme alone. If another app registers `magical-merchant://steal/callback` the JWT reaches that app
 * AIDEV-NOTE: compare the whole normalized href instead of listing conditions. `.../callback#` reports its hash as "" and slips past a condition
 */
function parseAppRedirect(redirect: string): URL | null {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return null;
  }
  // A form that hides the host by putting something plausible in the userinfo is
  // dropped at either entrance
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.protocol === DEEP_LINK_PROTOCOL) {
    // There is only one form that gets through, so comparing the normalized URL with
    // that one form whole is surer than counting conditions
    return url.href === DEEP_LINK_REDIRECT ? url : null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    return null;
  }
  // The loopback refuses a query and a fragment for the same reason. `?token=` is
  // appended at the end, so a `?` or `#` already there keeps the token from the listener
  return url.href === `${url.origin}${url.pathname}` ? url : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Android Chrome discards a navigation to a custom scheme that no user action drove.
 * An automatic navigation alone cannot get back to the app, so a tappable link is
 * always left in place.
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

/** The OAuth entrance: sends the user on to Google's consent screen with a 302. */
function handleAuthGoogle(url: URL, env: Env): Response {
  const state = generateState();
  const appRedirect = url.searchParams.get("app_redirect") ?? DEEP_LINK_REDIRECT;
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

/** The OAuth exit: trades the code for a token, issues a JWT and returns to the app. */
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
    appRedirect = appRedirectCookie ? decodeURIComponent(appRedirectCookie) : DEEP_LINK_REDIRECT;
  } catch {
    // Keeps a malformed %-encoding from throwing and turning into a 500
    return errorResponse("Invalid redirect", 400);
  }
  // This is only the value passed at the entrance coming back through a cookie, but it
  // is looked at here too. Swap the cookie directly and that one move changes where the
  // token goes
  const parsedRedirect = parseAppRedirect(appRedirect);
  if (!parsedRedirect) {
    return errorResponse("Invalid redirect", 400);
  }
  // The destination is built from the normalized URL. Even a string that passed
  // validation leaves what precedes `?token=` up to the shape of that validation
  const redirectUrl = `${parsedRedirect.href}?token=${encodeURIComponent(jwt)}`;

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

    if (!isAllowedSub(env.ALLOWED_SUBS, claims.sub)) {
      return errorResponse("This bucket belongs to somebody else", 403);
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
