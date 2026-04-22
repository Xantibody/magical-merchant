import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "./index";

const AUTH_HEADER = { "Cf-Access-Jwt-Assertion": "test-jwt-token" };

function request(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	const headers = { ...AUTH_HEADER, ...options.headers };
	return new Request(`http://localhost${path}`, { ...options, headers });
}

async function jsonBody<T>(response: Response): Promise<T> {
	return response.json() as Promise<T>;
}

describe("Workers R2 Proxy", () => {
	describe("Authentication", () => {
		it("rejects requests without CF Access JWT", async () => {
			const req = new Request("http://localhost/files");
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(res.status).toBe(401);
			const body = await jsonBody<{ error: string }>(res);
			expect(body.error).toBe("Unauthorized");
		});

		it("accepts requests with CF Access JWT", async () => {
			const req = request("/files");
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(res.status).toBe(200);
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
			expect(res.headers.get("X-Last-Modified")).toBe(
				"2026-04-22T12:00:00Z",
			);
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
			expect(getRes.headers.get("X-Last-Modified")).toBe(
				"2026-04-22T14:00:00Z",
			);
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
