import { describe, it, expect } from "vitest";
import { isUnsafeKey } from "./sync";

describe("isUnsafeKey", () => {
  it("rejects path traversal", () => {
    expect(isUnsafeKey("../etc/passwd")).toBe(true);
    expect(isUnsafeKey("notes/../other.md")).toBe(true);
  });

  it("rejects null bytes", () => {
    expect(isUnsafeKey("notes/a\0.md")).toBe(true);
  });

  it("rejects absolute paths", () => {
    expect(isUnsafeKey("/etc/passwd")).toBe(true);
  });

  it("rejects _sync-state/ prefix", () => {
    expect(isUnsafeKey("_sync-state/user.json")).toBe(true);
  });

  it("accepts normal keys", () => {
    expect(isUnsafeKey("notes/a.md")).toBe(false);
    expect(isUnsafeKey("projects/foo/active/task.md")).toBe(false);
    expect(isUnsafeKey("notes/file.sync-conflict-20260512-120000.md")).toBe(false);
  });
});
