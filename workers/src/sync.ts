interface FileSyncRecord {
  hash: string;
  last_modified: string;
}

export interface SyncState {
  files: Record<string, FileSyncRecord>;
  last_sync: string | null;
}

export interface FileContent {
  key: string;
  content_base64: string;
  last_modified: string;
}

export interface ConflictOp {
  key: string;
  conflict_key: string;
  resolution: "keep_local" | "keep_remote";
  content_base64?: string;
}

export interface BulkRequest {
  uploads: FileContent[];
  downloads: string[];
  delete_remote: string[];
  conflicts: ConflictOp[];
  new_state: SyncState;
  expected_etag: string | null;
}

export interface BulkResponse {
  downloads: FileContent[];
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

function base64Encode(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isUnsafeKey(key: string): boolean {
  return (
    key.includes("..") ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.startsWith(SYNC_STATE_PREFIX)
  );
}

async function executeUpload(bucket: R2Bucket, f: FileContent): Promise<void> {
  if (isUnsafeKey(f.key)) throw new Error(`unsafe key: ${f.key}`);
  const body = base64Decode(f.content_base64);
  await bucket.put(f.key, body, {
    customMetadata: { lastModified: f.last_modified },
  });
}

async function executeDownload(bucket: R2Bucket, key: string): Promise<FileContent> {
  if (isUnsafeKey(key)) throw new Error(`unsafe key: ${key}`);
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`not found: ${key}`);
  const lastModified = obj.customMetadata?.lastModified ?? obj.uploaded.toISOString();
  const buf = await obj.arrayBuffer();
  return {
    key,
    content_base64: base64Encode(buf),
    last_modified: lastModified,
  };
}

async function executeConflict(bucket: R2Bucket, c: ConflictOp): Promise<FileContent | null> {
  if (isUnsafeKey(c.key) || isUnsafeKey(c.conflict_key)) {
    throw new Error(`unsafe key: ${c.key} or ${c.conflict_key}`);
  }

  if (c.resolution === "keep_local") {
    // Save current remote content under conflict_key, then overwrite with local
    const remote = await bucket.get(c.key);
    if (remote) {
      const remoteLm = remote.customMetadata?.lastModified ?? remote.uploaded.toISOString();
      await bucket.put(c.conflict_key, remote.body, {
        customMetadata: { lastModified: remoteLm },
      });
    }
    if (c.content_base64 !== undefined) {
      const body = base64Decode(c.content_base64);
      await bucket.put(c.key, body, {
        customMetadata: { lastModified: new Date().toISOString() },
      });
    }
    return null;
  } else {
    // keep_remote: client will save local as conflict copy locally,
    // and downloads remote content. We just return remote content so client can write both.
    const obj = await bucket.get(c.key);
    if (!obj) throw new Error(`conflict download not found: ${c.key}`);
    const lastModified = obj.customMetadata?.lastModified ?? obj.uploaded.toISOString();
    const buf = await obj.arrayBuffer();
    return {
      key: c.key,
      content_base64: base64Encode(buf),
      last_modified: lastModified,
    };
  }
}

export async function executeBulk(bucket: R2Bucket, req: BulkRequest): Promise<BulkResponse> {
  // Validate all keys upfront
  for (const u of req.uploads) {
    if (isUnsafeKey(u.key)) throw new Error(`unsafe upload key: ${u.key}`);
  }
  for (const d of req.downloads) {
    if (isUnsafeKey(d)) throw new Error(`unsafe download key: ${d}`);
  }
  for (const d of req.delete_remote) {
    if (isUnsafeKey(d)) throw new Error(`unsafe delete key: ${d}`);
  }

  // Run all R2 operations concurrently
  const [, downloads, conflictDownloads] = await Promise.all([
    Promise.all(req.uploads.map((f) => executeUpload(bucket, f))),
    Promise.all(req.downloads.map((k) => executeDownload(bucket, k))),
    Promise.all(req.conflicts.map((c) => executeConflict(bucket, c))),
    req.delete_remote.length > 0 ? bucket.delete(req.delete_remote) : Promise.resolve(),
  ]);

  const allDownloads: FileContent[] = [
    ...downloads,
    ...conflictDownloads.filter((d): d is FileContent => d !== null),
  ];

  return { downloads: allDownloads };
}
