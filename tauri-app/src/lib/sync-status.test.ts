import { describe, it, expect, afterEach } from "vitest";
import { setLocale, t } from "./i18n";
import { describeSyncResult, describeSyncError } from "./sync-status";
import type { SyncIssue } from "./sync-status";

const emptyResult = {
  uploaded: 0,
  downloaded: 0,
  deleted_remote: 0,
  deleted_local: 0,
  conflicts: 0,
  errors: [] as SyncIssue[],
};

describe("describeSyncResult", () => {
  // 既定は test-setup の ja。英語を見たいところだけ切り替える
  afterEach(() => setLocale("ja"));

  it("reports up to date when nothing changed", () => {
    const ui = describeSyncResult(emptyResult);
    expect(ui.status).toBe("success");
    expect(ui.message).toBe(t().sync.result.upToDate);
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
    expect(ui.message).not.toBe(t().sync.result.upToDate);
  });

  it("mentions conflicts", () => {
    const ui = describeSyncResult({ ...emptyResult, downloaded: 1, conflicts: 2 });
    expect(ui.status).toBe("success");
    expect(ui.message).toContain("2");
    expect(ui.message).toContain(t().sync.result.conflictsSaved(2));
  });

  // core は英文ではなく kind とキーを返す。文にするのはここなので、
  // 選ばれている言語で出る
  it("reports failures in japanese", () => {
    const ui = describeSyncResult({
      ...emptyResult,
      uploaded: 1,
      errors: [
        { kind: "delete_skipped_changed", key: "notes/a.md" },
        { kind: "write_failed", key: "notes/b.md", detail: "disk full" },
      ],
    });
    expect(ui.status).toBe("error");
    expect(ui.message).toContain("2 件が失敗");
    expect(ui.message).toContain("notes/a.md");
  });

  it("reports the same failure in english", () => {
    setLocale("en");
    const ui = describeSyncResult({
      ...emptyResult,
      errors: [{ kind: "delete_skipped_changed", key: "notes/a.md" }],
    });
    expect(ui.message).toContain("1 item(s) failed");
    expect(ui.message).toContain("notes/a.md");
  });

  // 詳細を落とすと、書き込み失敗の原因 (容量・権限) が画面から消える
  it("keeps the detail core attached to a failure", () => {
    const ui = describeSyncResult({
      ...emptyResult,
      errors: [{ kind: "write_failed", key: "notes/b.md", detail: "disk full" }],
    });
    expect(ui.message).toContain("disk full");
  });
});

describe("describeSyncError", () => {
  it("maps notConfigured to needs-setup", () => {
    const ui = describeSyncError({ kind: "notConfigured", message: "Sync is not set up." });
    expect(ui.status).toBe("needs-setup");
    expect(ui.message).toContain("Sync is not set up.");
  });

  it("maps notAuthenticated to needs-setup", () => {
    const ui = describeSyncError({ kind: "notAuthenticated", message: "Not logged in." });
    expect(ui.status).toBe("needs-setup");
  });

  it("maps network errors to error with message", () => {
    const ui = describeSyncError({ kind: "network", message: "Network error: timeout" });
    expect(ui.status).toBe("error");
    expect(ui.message).toBe("Network error: timeout");
  });

  // アプリ内の再入だけでなく、CLI がロックを持っているときにも返ってくる。
  // 待機に戻さないと "syncing" のまま固まり、以後の同期が始められない
  it("returns to idle without a message when another process is syncing", () => {
    const ui = describeSyncError({ kind: "busy", message: "Sync already in progress" });
    expect(ui.status).toBe("idle");
    expect(ui.message).toBe("");
  });

  it("handles plain string errors from older code paths", () => {
    const ui = describeSyncError("something broke");
    expect(ui.status).toBe("error");
    expect(ui.message).toBe("something broke");
  });
});
