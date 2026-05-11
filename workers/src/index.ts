import { SignJWT, jwtVerify } from "jose";
import {
  type ClientFile,
  type SyncPlan,
  buildAckState,
  computeSyncPlan,
  loadSyncState,
  saveSyncState,
} from "./sync";

interface Env {
  BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  JWT_SECRET: string;
  JWT_EXPIRY_SECONDS?: string;
}

interface FileEntry {
  key: string;
  lastModified: string;
  size: number;
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

const DEFAULT_JWT_EXPIRY_SECONDS = 259200; // 3 days

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function extractKey(pathname: string): string | null {
  const prefix = "/files/";
  if (!pathname.startsWith(prefix)) return null;
  return decodeURIComponent(pathname.slice(prefix.length));
}

function containsTraversal(key: string): boolean {
  return key.includes("..") || key.includes("\0");
}

async function listAllObjects(bucket: R2Bucket): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      cursor,
      limit: 1000,
      include: ["customMetadata"],
    });
    for (const obj of listed.objects) {
      const lastModified = obj.customMetadata?.lastModified ?? obj.uploaded.toISOString();
      files.push({
        key: obj.key,
        lastModified,
        size: obj.size,
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return files;
}

async function handleList(bucket: R2Bucket): Promise<Response> {
  const files = (await listAllObjects(bucket)).filter((f) => !f.key.startsWith("_sync-state/"));
  return jsonResponse({ files });
}

async function handleGet(bucket: R2Bucket, key: string): Promise<Response> {
  const object = await bucket.get(key);
  if (!object) {
    return errorResponse("Not found", 404);
  }
  const lastModified = object.customMetadata?.lastModified ?? object.uploaded.toISOString();
  return new Response(object.body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Last-Modified": lastModified,
    },
  });
}

async function handlePut(bucket: R2Bucket, key: string, request: Request): Promise<Response> {
  const body = await request.text();
  const lastModified = request.headers.get("X-Last-Modified") ?? new Date().toISOString();

  await bucket.put(key, body, {
    customMetadata: { lastModified },
  });

  return jsonResponse({ key, lastModified }, 201);
}

async function handleDelete(bucket: R2Bucket, key: string): Promise<Response> {
  await bucket.delete(key);
  return new Response(null, { status: 204 });
}

interface SyncRequest {
  files: ClientFile[];
}

interface SyncAckRequest {
  files: ClientFile[];
  etag: string | null;
}

async function handleSync(bucket: R2Bucket, userId: string, request: Request): Promise<Response> {
  let body: SyncRequest;
  try {
    body = (await request.json()) as SyncRequest;
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (!Array.isArray(body.files)) {
    return errorResponse("Invalid request: files must be an array", 400);
  }

  const { state, etag } = await loadSyncState(bucket, userId);
  const remoteFiles = (await listAllObjects(bucket)).filter(
    (f) => !f.key.startsWith("_sync-state/"),
  );

  const actions = computeSyncPlan(body.files, remoteFiles, state);

  const plan: SyncPlan = { actions, etag };
  return jsonResponse(plan);
}

async function handleSyncAck(
  bucket: R2Bucket,
  userId: string,
  request: Request,
): Promise<Response> {
  let body: SyncAckRequest;
  try {
    body = (await request.json()) as SyncAckRequest;
  } catch {
    return errorResponse("Invalid JSON", 400);
  }
  if (!Array.isArray(body.files)) {
    return errorResponse("Invalid request: files must be an array", 400);
  }

  const newState = buildAckState(body.files);
  const saved = await saveSyncState(bucket, userId, newState, body.etag);
  if (!saved) {
    return errorResponse("Sync conflict: state was modified concurrently, please retry", 409);
  }

  return jsonResponse({ last_sync: newState.last_sync });
}

async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setExpirationTime(payload.exp)
    .sign(key);
}

async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return { sub: payload.sub, email: payload.email as string, exp: payload.exp! };
  } catch {
    return null;
  }
}

function generateState(): string {
  return crypto.randomUUID();
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

function isAllowedRedirect(redirect: string): boolean {
  return redirect.startsWith("magical-merchant://") || redirect.startsWith("http://127.0.0.1:");
}

function getJwtExpiry(env: Env): number {
  if (env.JWT_EXPIRY_SECONDS) {
    const parsed = parseInt(env.JWT_EXPIRY_SECONDS, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_JWT_EXPIRY_SECONDS;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // OAuth: redirect to Google
    if (pathname === "/auth/google" && method === "GET") {
      const state = generateState();
      const appRedirect =
        url.searchParams.get("app_redirect") ?? "magical-merchant://auth/callback";
      if (!isAllowedRedirect(appRedirect)) {
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

    // OAuth: callback — exchange code for token, issue JWT, deep link
    if (pathname === "/auth/callback" && method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) {
        return errorResponse("Missing authorization code", 400);
      }

      // Validate state against cookie
      const stateParam = url.searchParams.get("state");
      const stateCookie = getCookie(request, "__oauth_state");
      if (!stateParam || !stateCookie || stateParam !== stateCookie) {
        return errorResponse("Invalid state parameter", 403);
      }

      // Exchange code for access token
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

      // Get user info
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

      // Issue JWT
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
      const appRedirect = appRedirectCookie
        ? decodeURIComponent(appRedirectCookie)
        : "magical-merchant://auth/callback";
      if (!isAllowedRedirect(appRedirect)) {
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
      if (appRedirect.startsWith("http://127.0.0.1")) {
        clearCookies.set("Location", redirectUrl);
        return new Response(null, { status: 302, headers: clearCookies });
      }

      return new Response(
        `<html><body><p>Redirecting to app...</p><script>window.location.href="${redirectUrl}";</script></body></html>`,
        { status: 200, headers: clearCookies },
      );
    }

    // Bearer token authentication
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      return errorResponse("Unauthorized", 401);
    }

    const claims = await verifyJwt(token, env.JWT_SECRET);
    if (!claims) {
      return errorResponse("Unauthorized", 401);
    }

    if (pathname === "/sync" && method === "POST") {
      return handleSync(env.BUCKET, claims.sub, request);
    }

    if (pathname === "/sync/ack" && method === "POST") {
      return handleSyncAck(env.BUCKET, claims.sub, request);
    }

    if (pathname === "/files" && method === "GET") {
      return handleList(env.BUCKET);
    }

    const key = extractKey(pathname);
    if (!key || key.length === 0) {
      return errorResponse("Invalid path", 400);
    }

    if (containsTraversal(key)) {
      return errorResponse("Path traversal not allowed", 400);
    }

    if (key.startsWith("_sync-state/")) {
      return errorResponse("Access denied", 403);
    }

    switch (method) {
      case "GET":
        return handleGet(env.BUCKET, key);
      case "PUT":
        return handlePut(env.BUCKET, key, request);
      case "DELETE":
        return handleDelete(env.BUCKET, key);
      default:
        return errorResponse("Method not allowed", 405);
    }
  },
} satisfies ExportedHandler<Env>;
