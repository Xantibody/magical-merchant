interface FileSyncRecord {
  hash: string;
  last_modified: string;
}

export interface SyncState {
  files: Record<string, FileSyncRecord>;
  last_sync: string | null;
}

export interface ClientFile {
  key: string;
  hash: string;
  last_modified: string;
}

export interface RemoteFile {
  key: string;
  lastModified: string;
  size: number;
}

export type SyncActionType = "upload" | "download" | "delete_local" | "delete_remote" | "conflict";

export interface SyncAction {
  type: SyncActionType;
  key: string;
  conflict_key?: string;
  resolution?: "keep_local" | "keep_remote";
}

export interface SyncPlan {
  actions: SyncAction[];
  etag: string | null;
}

const SYNC_STATE_PREFIX = "_sync-state/";

export async function loadSyncState(
  bucket: R2Bucket,
  userId: string,
): Promise<{ state: SyncState; etag: string | null }> {
  const key = `${SYNC_STATE_PREFIX}${userId}.json`;
  const obj = await bucket.get(key);
  if (!obj) {
    return { state: { files: {}, last_sync: null }, etag: null };
  }
  const state = (await obj.json()) as SyncState;
  return { state, etag: obj.etag };
}

export async function saveSyncState(
  bucket: R2Bucket,
  userId: string,
  state: SyncState,
  expectedEtag: string | null,
): Promise<boolean> {
  const key = `${SYNC_STATE_PREFIX}${userId}.json`;
  const body = JSON.stringify(state);

  if (expectedEtag) {
    const result = await bucket.put(key, body, {
      onlyIf: { etagMatches: expectedEtag },
    });
    return result !== null;
  }

  await bucket.put(key, body);
  return true;
}

export function computeSyncPlan(
  clientFiles: ClientFile[],
  remoteFiles: RemoteFile[],
  state: SyncState,
): SyncAction[] {
  const actions: SyncAction[] = [];

  const clientMap = new Map(clientFiles.map((f) => [f.key, f]));
  const remoteMap = new Map(remoteFiles.map((f) => [f.key, f]));

  const allKeys = new Set([...clientMap.keys(), ...remoteMap.keys()]);

  for (const key of allKeys) {
    if (key.startsWith(SYNC_STATE_PREFIX)) continue;

    const client = clientMap.get(key);
    const remote = remoteMap.get(key);
    const record = state.files[key];

    if (client && remote && record) {
      const clientChanged = client.hash !== record.hash;
      const remoteChanged = remote.lastModified !== record.last_modified;

      if (clientChanged && remoteChanged) {
        const resolution = resolveConflict(client.last_modified, remote.lastModified);
        const conflictKey = generateConflictKey(key);
        actions.push({ type: "conflict", key, resolution, conflict_key: conflictKey });
      } else if (clientChanged) {
        actions.push({ type: "upload", key });
      } else if (remoteChanged) {
        actions.push({ type: "download", key });
      }
    } else if (client && remote && !record) {
      const resolution = resolveConflict(client.last_modified, remote.lastModified);
      const conflictKey = generateConflictKey(key);
      actions.push({ type: "conflict", key, resolution, conflict_key: conflictKey });
    } else if (client && !remote && !record) {
      actions.push({ type: "upload", key });
    } else if (!client && remote && !record) {
      actions.push({ type: "download", key });
    } else if (client && !remote && record) {
      // Remote was deleted by another device → delete local copy
      actions.push({ type: "delete_local", key });
    } else if (!client && remote && record) {
      // Client deleted it → delete remote copy
      actions.push({ type: "delete_remote", key });
    }
  }

  actions.sort((a, b) => a.key.localeCompare(b.key));
  return actions;
}

function resolveConflict(
  clientModified: string,
  remoteModified: string,
): "keep_local" | "keep_remote" {
  return new Date(clientModified) >= new Date(remoteModified) ? "keep_local" : "keep_remote";
}

function generateConflictKey(key: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

  const lastDot = key.lastIndexOf(".");
  const lastSlash = key.lastIndexOf("/");
  if (lastDot > lastSlash) {
    const stem = key.slice(0, lastDot);
    const ext = key.slice(lastDot);
    return `${stem}.sync-conflict-${ts}${ext}`;
  }
  return `${key}.sync-conflict-${ts}`;
}

export function buildAckState(ackFiles: ClientFile[]): SyncState {
  const files: Record<string, FileSyncRecord> = {};
  for (const f of ackFiles) {
    files[f.key] = { hash: f.hash, last_modified: f.last_modified };
  }
  return { files, last_sync: new Date().toISOString() };
}
