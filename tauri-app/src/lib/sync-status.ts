import { t } from "./i18n";

/**
 * 同期の途中で 1 件だけこけたときの記録 (core の `SyncIssue`)。
 *
 * core は文を組まない — CLI や MCP からも呼ばれ、翻訳表を置く場所が無いので、
 * `kind` と材料だけが届く。日本語にするのは `i18n.ts` の `sync.result.issue`。
 */
export type SyncIssue =
  | { kind: "unsafe_key"; key: string }
  | { kind: "missing_local_file"; key: string }
  | { kind: "read_failed"; key: string; detail: string }
  | { kind: "write_failed"; key: string; detail: string }
  | { kind: "decode_failed"; key: string; detail: string }
  | { kind: "delete_failed"; key: string; detail: string }
  | { kind: "delete_skipped_changed"; key: string };

export interface SyncResultPayload {
  uploaded: number;
  downloaded: number;
  deleted_remote: number;
  deleted_local: number;
  conflicts: number;
  errors: SyncIssue[];
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
  const strings = t().sync.result;

  const [first] = result.errors ?? [];
  if (first) {
    return {
      status: "error",
      message: strings.failed(result.errors.length, strings.issue(first)),
    };
  }

  const changed =
    result.uploaded + result.downloaded + result.deleted_remote + result.deleted_local;
  if (changed === 0 && result.conflicts === 0) {
    return { status: "success", message: strings.upToDate };
  }

  // 矢印と数字は言語を持たない。訳すのは前後の言葉だけ
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
  let message = strings.synced(parts.join(" ")).trim();
  if (result.conflicts) {
    message += ` · ${strings.conflictsSaved(result.conflicts)}`;
  }
  return { status: "success", message };
}

function toErrorInfo(err: unknown): SyncErrorInfo {
  return typeof err === "object" && err !== null && "message" in err
    ? (err as SyncErrorInfo)
    : { kind: "other", message: String(err) };
}

/** core が付けた `kind`。分類できない失敗 (投げられた文字列など) は `"other"`。 */
export function syncErrorKind(err: unknown): string {
  return toErrorInfo(err).kind;
}

export function describeSyncError(err: unknown): SyncUiState {
  const info = toErrorInfo(err);

  // 別の同期が走っていただけ。今はアプリ内の再入だけだが、CLI から同期
  // できるようになれば (#170) 相手がロックを持っている場合も来る。異常では
  // ないので何も知らせないが、待機に戻すのは必須: "syncing" のまま止めると
  // syncNow の再入ガードに引っかかり、以後どの同期も始まらなくなる
  if (info.kind === "busy") {
    return { status: "idle", message: "" };
  }
  if (info.kind === "notConfigured" || info.kind === "notAuthenticated") {
    return { status: "needs-setup", message: info.message };
  }
  return { status: "error", message: info.message };
}
