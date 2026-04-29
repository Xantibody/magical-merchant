interface Env {
  BUCKET: R2Bucket;
}

interface FileEntry {
  key: string;
  lastModified: string;
  size: number;
}

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
  const files = await listAllObjects(bucket);
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

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Auth endpoint: extract JWT from CF_Authorization cookie and redirect via deep link
    if (pathname === "/auth/login" && method === "GET") {
      const jwt = getCookie(request, "CF_Authorization");
      if (!jwt) {
        return errorResponse("Authentication failed", 401);
      }
      const redirectUrl = `magical-merchant://auth/callback?token=${encodeURIComponent(jwt)}`;
      return new Response(
        `<html><body><p>Redirecting to app...</p><script>window.location.href="${redirectUrl}";</script></body></html>`,
        {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        },
      );
    }

    const jwt =
      request.headers.get("Cf-Access-Jwt-Assertion") ?? getCookie(request, "CF_Authorization");
    if (!jwt) {
      return errorResponse("Unauthorized", 401);
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
