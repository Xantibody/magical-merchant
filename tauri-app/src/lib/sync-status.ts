export interface SyncResultPayload {
  uploaded: number;
  downloaded: number;
  deleted_remote: number;
  deleted_local: number;
  conflicts: number;
  errors: string[];
}

interface SyncErrorInfo {
  kind: string;
  message: string;
}

export interface SyncUiState {
  status: "idle" | "success" | "error" | "needs-setup";
  message: string;
}

export function describeSyncResult(result: SyncResultPayload): SyncUiState {
  if (result.errors?.length) {
    return {
      status: "error",
      message: `${result.errors.length} item(s) failed — ${result.errors[0]}`,
    };
  }

  const changed =
    result.uploaded + result.downloaded + result.deleted_remote + result.deleted_local;
  if (changed === 0 && result.conflicts === 0) {
    return { status: "success", message: "Already up to date" };
  }

  const parts: string[] = [];
  if (result.uploaded) {
    parts.push(`↑${result.uploaded}`);
  }
  if (result.downloaded) {
    parts.push(`↓${result.downloaded}`);
  }
  if (result.deleted_remote + result.deleted_local) {
    parts.push(`−${result.deleted_remote + result.deleted_local}`);
  }
  let message = `Synced ${parts.join(" ")}`.trim();
  if (result.conflicts) {
    message += ` · ${result.conflicts} conflict(s) saved as copies`;
  }
  return { status: "success", message };
}

export function describeSyncError(err: unknown): SyncUiState {
  const info: SyncErrorInfo =
    typeof err === "object" && err !== null && "message" in err
      ? (err as SyncErrorInfo)
      : { kind: "other", message: String(err) };

  // 別の同期が走っていただけ。アプリ内の再入だけでなく、CLI が同じ
  // データディレクトリのロックを持っているときもここに来る。異常ではないので
  // 何も知らせないが、待機に戻すのは必須: "syncing" のまま止めると
  // syncNow の再入ガードに引っかかり、以後どの同期も始まらなくなる
  if (info.kind === "busy") {
    return { status: "idle", message: "" };
  }
  if (info.kind === "notConfigured" || info.kind === "notAuthenticated") {
    return { status: "needs-setup", message: info.message };
  }
  return { status: "error", message: info.message };
}
