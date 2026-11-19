import { base64Decode, base64Encode } from "./base64";

interface FileSyncRecord {
  hash: string;
  /// Version stamp of the sync state. Only the server issues it, so it does not
  /// depend on per-device clock skew or on filesystem mtime resolution.
  last_modified: string;
}

export interface SyncState {
  files: Record<string, FileSyncRecord>;
  last_sync: string | null;
}

interface FileContent {
  key: string;
  content_base64: string;
  last_modified: string;
}

interface UploadFile extends FileContent {
  hash: string;
}

interface ConflictOp {
  key: string;
  conflict_key: string;
  content_base64: string;
  hash: string;
  last_modified: string;
}

export interface BulkRequest {
  uploads: UploadFile[];
  downloads: string[];
  delete_remote: string[];
  conflicts: ConflictOp[];
  expected_etag: string | null;
}

export interface BulkOutcome {
  downloads: FileContent[];
  /// The remote content set aside on a conflict. The client saves it as a
  /// conflict copy.
  conflict_downloads: FileContent[];
}

export interface BulkResponse extends BulkOutcome {
  new_state: SyncState;
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

/// What escapes the tree is the `..` **path segment**, not dots that happen to sit
/// inside a name. Rejecting on a substring match would also catch a name ending in
/// `.sync-conflict-20260511-031336..md` (one dot too many, found in backups made
/// before server-driven sync), and a device holding such a backup would then fail
/// every sync. Keep this check in step with core's `is_safe_key`.
export function isUnsafeKey(key: string): boolean {
  return (
    key === "" ||
    key.split("/").some((segment) => segment === ".." || segment === ".") ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.startsWith(SYNC_STATE_PREFIX)
  );
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/// A corrupt hash written into the state makes every client either read "changed"
/// forever, or never detect a change again.
export function isValidHash(hash: unknown): boolean {
  return typeof hash === "string" && HASH_PATTERN.test(hash);
}

/// If the stamp for a key comes out as the same string as last time, other devices
/// miss the change. The Workers clock advances only per I/O, so make it monotonic
/// explicitly.
function nextStamp(previous: string | undefined, now: number): string {
  const nowMs = previous === undefined ? now : Math.max(now, Date.parse(previous) + 1);
  return new Date(nowMs).toISOString();
}

/// Only the server decides the new sync state.
/// Taking the list the client sent as it is would drop files the client does not
/// hold yet (the ones it is about to download) from the state, and on the next sync
/// every device would read that as "deleted on the remote" and delete the local
/// note.
export function deriveState(old: SyncState, req: BulkRequest, now: number): SyncState {
  const files: Record<string, FileSyncRecord> = { ...old.files };

  for (const u of req.uploads) {
    files[u.key] = { hash: u.hash, last_modified: nextStamp(files[u.key]?.last_modified, now) };
  }
  for (const key of req.delete_remote) {
    delete files[key];
  }
  for (const c of req.conflicts) {
    files[c.key] = { hash: c.hash, last_modified: nextStamp(files[c.key]?.last_modified, now) };
  }

  return { files, last_sync: new Date(now).toISOString() };
}

async function executeUpload(bucket: R2Bucket, f: UploadFile): Promise<void> {
  const body = base64Decode(f.content_base64);
  await bucket.put(f.key, body, {
    customMetadata: { lastModified: f.last_modified },
  });
}

async function executeDownload(bucket: R2Bucket, key: string): Promise<FileContent> {
  const obj = await bucket.get(key);
  if (!obj) {
    throw new Error(`not found: ${key}`);
  }
  const lastModified = obj.customMetadata?.lastModified ?? obj.uploaded.toISOString();
  const buf = await obj.arrayBuffer();
  return {
    key,
    content_base64: base64Encode(buf),
    last_modified: lastModified,
  };
}

/// A conflict always overwrites with the local side. The remote content that gets
/// overwritten is set aside in R2 and returned to the client as well, so neither
/// edit is lost.
async function executeConflict(bucket: R2Bucket, c: ConflictOp): Promise<FileContent | null> {
  const remote = await bucket.get(c.key);
  let preserved: FileContent | null = null;

  if (remote) {
    const remoteLm = remote.customMetadata?.lastModified ?? remote.uploaded.toISOString();
    const buf = await remote.arrayBuffer();
    await bucket.put(c.conflict_key, buf, {
      customMetadata: { lastModified: remoteLm },
    });
    preserved = {
      key: c.conflict_key,
      content_base64: base64Encode(buf),
      last_modified: remoteLm,
    };
  }

  await bucket.put(c.key, base64Decode(c.content_base64), {
    customMetadata: { lastModified: c.last_modified },
  });

  return preserved;
}

function collectKeys(req: BulkRequest): string[] {
  return [
    ...req.uploads.map((u) => u.key),
    ...req.downloads,
    ...req.delete_remote,
    ...req.conflicts.flatMap((c) => [c.key, c.conflict_key]),
  ];
}

export async function executeBulk(bucket: R2Bucket, req: BulkRequest): Promise<BulkOutcome> {
  // Validate all keys upfront so a rejected key never leaves a half-applied batch
  for (const key of collectKeys(req)) {
    if (isUnsafeKey(key)) {
      throw new Error(`unsafe key: ${key}`);
    }
  }

  const [, downloads, conflictDownloads] = await Promise.all([
    Promise.all(req.uploads.map((f) => executeUpload(bucket, f))),
    Promise.all(req.downloads.map((k) => executeDownload(bucket, k))),
    Promise.all(req.conflicts.map((c) => executeConflict(bucket, c))),
    req.delete_remote.length > 0 ? bucket.delete(req.delete_remote) : Promise.resolve(),
  ]);

  return {
    downloads,
    conflict_downloads: conflictDownloads.filter((d): d is FileContent => d !== null),
  };
}
