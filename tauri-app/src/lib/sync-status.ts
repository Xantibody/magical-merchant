import { t } from "./i18n";

/**
 * The record of one item failing in the middle of a sync (core's `SyncIssue`).
 *
 * core composes no sentences. It is also called from the CLI and MCP and has nowhere
 * to keep a translation table, so only `kind` and the material arrive. The Japanese
 * wording is `sync.result.issue` in `i18n.ts`.
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

  // Arrows and numbers have no language. Only the words around them are translated
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

/** The `kind` core attached. A failure that cannot be classified (a thrown string etc.) is `"other"`. */
export function syncErrorKind(err: unknown): string {
  return toErrorInfo(err).kind;
}

export function describeSyncError(err: unknown): SyncUiState {
  const info = toErrorInfo(err);

  // Another sync was just running. Both re-entry inside the app and
  // `magical-merchant sync` holding the lock arrive here. Not abnormal, so nothing
  // is reported, but returning to idle is mandatory: stuck at "syncing" it trips
  // the re-entry guard of syncNow, and no sync ever starts again
  if (info.kind === "busy") {
    return { status: "idle", message: "" };
  }
  if (info.kind === "notConfigured" || info.kind === "notAuthenticated") {
    return { status: "needs-setup", message: info.message };
  }
  return { status: "error", message: info.message };
}
