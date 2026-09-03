interface FileSyncRecord {
  hash: string;
  /// 同期状態のバージョン印。サーバーだけが発行するので、
  /// 端末ごとの時計ずれやファイルシステムの mtime 精度に左右されない。
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
  /// 競合で退避したリモート側の中身。クライアントが競合コピーとして保存する。
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

function base64Encode(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
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

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/// 壊れたハッシュを state に入れると、全クライアントで「常に変更あり」と
/// 判定され続けるか、逆に変更が永久に検出されなくなる。
export function isValidHash(hash: unknown): boolean {
  return typeof hash === "string" && HASH_PATTERN.test(hash);
}

/// 同じキーの版が前回と同じ文字列になると、他端末が変更を取りこぼす。
/// Workers の時計は I/O 単位でしか進まないので、明示的に単調化する。
function nextStamp(previous: string | undefined, now: number): string {
  const nowMs = previous === undefined ? now : Math.max(now, Date.parse(previous) + 1);
  return new Date(nowMs).toISOString();
}

/// 新しい同期状態はサーバーだけが決める。
/// クライアントが送ってきた一覧をそのまま採用すると、まだ手元に無いファイル
/// （これからダウンロードするもの）が状態から消え、次の同期で全端末が
/// 「リモートで削除された」と解釈してローカルのノートを消してしまう。
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

/// 競合は常にローカル優先で上書きする。ただし上書きされるリモート側の中身は
/// R2 に退避したうえでクライアントにも返し、どちらの編集も失わせない。
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
