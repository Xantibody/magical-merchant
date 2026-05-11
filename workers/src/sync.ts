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
  sync_token: string;
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
      actions.push({ type: "delete_remote", key });
    } else if (!client && remote && record) {
      actions.push({ type: "delete_local", key });
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
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 15)
    .replace(/(\d{8})(\d{6})/, "$1-$2");

  const lastDot = key.lastIndexOf(".");
  const lastSlash = key.lastIndexOf("/");
  if (lastDot > lastSlash) {
    const stem = key.slice(0, lastDot);
    const ext = key.slice(lastDot);
    return `${stem}.sync-conflict-${ts}${ext}`;
  }
  return `${key}.sync-conflict-${ts}`;
}

export function buildUpdatedState(
  state: SyncState,
  actions: SyncAction[],
  clientFiles: ClientFile[],
  remoteFiles: RemoteFile[],
): SyncState {
  const clientMap = new Map(clientFiles.map((f) => [f.key, f]));
  const remoteMap = new Map(remoteFiles.map((f) => [f.key, f]));
  const newFiles = { ...state.files };

  for (const action of actions) {
    switch (action.type) {
      case "upload": {
        const client = clientMap.get(action.key);
        if (client) {
          newFiles[action.key] = { hash: client.hash, last_modified: client.last_modified };
        }
        break;
      }
      case "download": {
        const remote = remoteMap.get(action.key);
        if (remote) {
          newFiles[action.key] = { hash: "", last_modified: remote.lastModified };
        }
        break;
      }
      case "delete_local":
      case "delete_remote":
        delete newFiles[action.key];
        break;
      case "conflict": {
        if (action.resolution === "keep_local") {
          const client = clientMap.get(action.key);
          if (client) {
            newFiles[action.key] = { hash: client.hash, last_modified: client.last_modified };
          }
        } else {
          const remote = remoteMap.get(action.key);
          if (remote) {
            newFiles[action.key] = { hash: "", last_modified: remote.lastModified };
          }
        }
        break;
      }
    }
  }

  return { files: newFiles, last_sync: new Date().toISOString() };
}
