import { describe, it, expect } from "vitest";
import { describeSyncResult, describeSyncError } from "./sync-status";

const emptyResult = {
  uploaded: 0,
  downloaded: 0,
  deleted_remote: 0,
  deleted_local: 0,
  conflicts: 0,
  errors: [] as string[],
};

describe("describeSyncResult", () => {
  it("reports up to date when nothing changed", () => {
    const ui = describeSyncResult(emptyResult);
    expect(ui.status).toBe("success");
    expect(ui.message).toBe("Already up to date");
  });

  it("reports upload and download counts", () => {
    const ui = describeSyncResult({ ...emptyResult, uploaded: 2, downloaded: 1 });
    expect(ui.status).toBe("success");
    expect(ui.message).toContain("↑2");
    expect(ui.message).toContain("↓1");
  });

  it("counts deletions as changes", () => {
    const ui = describeSyncResult({ ...emptyResult, deleted_remote: 1, deleted_local: 2 });
    expect(ui.status).toBe("success");
    expect(ui.message).not.toBe("Already up to date");
  });

  it("mentions conflicts", () => {
    const ui = describeSyncResult({ ...emptyResult, downloaded: 1, conflicts: 2 });
    expect(ui.status).toBe("success");
    expect(ui.message).toContain("2 conflict(s)");
  });

  it("reports errors with the first error message", () => {
    const ui = describeSyncResult({
      ...emptyResult,
      uploaded: 1,
      errors: ["upload notes/a.md: Network error: timeout", "upload notes/b.md: HTTP 500"],
    });
    expect(ui.status).toBe("error");
    expect(ui.message).toContain("2");
    expect(ui.message).toContain("upload notes/a.md");
  });
});

describe("describeSyncError", () => {
  it("maps notConfigured to needs-setup", () => {
    const ui = describeSyncError({ kind: "notConfigured", message: "Sync is not set up." });
    expect(ui?.status).toBe("needs-setup");
    expect(ui?.message).toContain("Sync is not set up.");
  });

  it("maps notAuthenticated to needs-setup", () => {
    const ui = describeSyncError({ kind: "notAuthenticated", message: "Not logged in." });
    expect(ui?.status).toBe("needs-setup");
  });

  it("maps network errors to error with message", () => {
    const ui = describeSyncError({ kind: "network", message: "Network error: timeout" });
    expect(ui?.status).toBe("error");
    expect(ui?.message).toBe("Network error: timeout");
  });

  it("ignores busy (another sync running)", () => {
    const ui = describeSyncError({ kind: "busy", message: "Sync already in progress" });
    expect(ui).toBeNull();
  });

  it("handles plain string errors from older code paths", () => {
    const ui = describeSyncError("something broke");
    expect(ui?.status).toBe("error");
    expect(ui?.message).toBe("something broke");
  });
});
