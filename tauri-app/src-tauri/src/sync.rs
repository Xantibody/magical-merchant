use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::{DateTime, Utc};
use magical_merchant_core::sync::conflict;
use magical_merchant_core::sync::diff::{self, RemoteFile, SyncAction};
use magical_merchant_core::sync::scan::{self, LocalFile};
use magical_merchant_core::sync::state::{FileSyncRecord, SyncState};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::auth;

const EVENT_SYNC_COMPLETE: &str = "sync-complete";
const EVENT_SYNC_ERROR: &str = "sync-error";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SyncStatusInfo {
    pub is_syncing: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct SyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

/// フロントが「設定へ誘導」「再試行」などを出し分けられるよう、
/// エラーを kind 付きで返す
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SyncErrorInfo {
    pub kind: &'static str,
    pub message: String,
}

impl SyncErrorInfo {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// 分類できない内部エラー用。UI は汎用のエラー表示にフォールバックする
    fn other(message: impl Into<String>) -> Self {
        Self::new("other", message)
    }
}

pub(crate) struct AppSyncState {
    pub is_syncing: AtomicBool,
    pub last_synced_at: Mutex<Option<DateTime<Utc>>>,
    pub last_error: Mutex<Option<String>>,
}

impl Default for AppSyncState {
    fn default() -> Self {
        Self {
            is_syncing: AtomicBool::new(false),
            last_synced_at: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }
}

// ──────────── HTTP wire types ────────────

/// 同期状態はサーバーが持つ。クライアントは受け取った状態をそのまま保存するだけで、
/// 自分で組み立てて送り返さない（送り返すと、まだ手元に無いファイルが状態から
/// 抜け落ち、次の同期で全端末がそれを「削除された」と解釈してしまう）
#[derive(Debug, Clone, Deserialize)]
struct ServerSyncState {
    files: std::collections::HashMap<String, ServerFileRecord>,
    #[allow(dead_code)]
    last_sync: Option<String>,
    /// bulk レスポンスの `new_state` には付かない
    #[serde(default)]
    etag: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ServerFileRecord {
    hash: String,
    last_modified: String,
}

#[derive(Serialize)]
struct WireUpload {
    key: String,
    content_base64: String,
    last_modified: String,
    hash: String,
}

/// 競合は常にローカル優先。上書きされるリモート側は `conflict_key` に退避され、
/// レスポンスでも返ってくるのでローカルにも競合コピーとして残す
#[derive(Serialize)]
struct WireConflictOp {
    key: String,
    conflict_key: String,
    content_base64: String,
    hash: String,
    last_modified: String,
}

#[derive(Serialize)]
struct BulkRequest {
    uploads: Vec<WireUpload>,
    downloads: Vec<String>,
    delete_remote: Vec<String>,
    conflicts: Vec<WireConflictOp>,
    expected_etag: Option<String>,
}

#[derive(Deserialize)]
struct BulkResponse {
    downloads: Vec<DownloadedFile>,
    conflict_downloads: Vec<DownloadedFile>,
    new_state: ServerSyncState,
}

#[derive(Deserialize)]
struct DownloadedFile {
    key: String,
    content_base64: String,
}

// ──────────── HTTP client ────────────

// Android 側は失敗しうるので、両方を同じ型で呼べるように揃える
#[allow(clippy::unnecessary_wraps)]
#[cfg(not(target_os = "android"))]
fn http_client() -> Result<reqwest::Client, SyncErrorInfo> {
    Ok(reqwest::Client::new())
}

/// Android だけ端末の検証器を迂回する。理由は `android_tls::sync_tls_config`
#[cfg(target_os = "android")]
fn http_client() -> Result<reqwest::Client, SyncErrorInfo> {
    let tls = crate::android_tls::sync_tls_config()
        .map_err(|e| SyncErrorInfo::other(format!("TLS setup failed: {e}")))?;
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .build()
        .map_err(|e| SyncErrorInfo::other(format!("HTTP client setup failed: {}", describe(&e))))
}

struct HttpClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl HttpClient {
    fn new(base_url: String, token: String) -> Result<Self, SyncErrorInfo> {
        Ok(Self {
            http: http_client()?,
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    async fn get_sync_state(&self) -> Result<ServerSyncState, SyncErrorInfo> {
        let resp = self
            .http
            .get(format!("{}/sync-state", self.base_url))
            .header("Authorization", self.auth())
            .send()
            .await
            .map_err(network_error)?;

        let resp = check_status(resp, "get_sync_state").await?;

        resp.json()
            .await
            .map_err(|e| SyncErrorInfo::other(format!("Failed to parse sync state: {e}")))
    }

    async fn bulk(&self, req: BulkRequest) -> Result<BulkResponse, SyncErrorInfo> {
        let resp = self
            .http
            .post(format!("{}/sync/bulk", self.base_url))
            .header("Authorization", self.auth())
            .json(&req)
            .send()
            .await
            .map_err(network_error)?;

        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err(SyncErrorInfo::new(
                "conflict",
                "Sync state changed concurrently, please retry",
            ));
        }

        let resp = check_status(resp, "bulk").await?;

        resp.json()
            .await
            .map_err(|e| SyncErrorInfo::other(format!("Failed to parse bulk response: {e}")))
    }
}

/// reqwest 0.12 以降の `Display` は「error sending request for url (…)」で
/// 止まり、DNS・TCP・TLS のどこで落ちたかは `source()` を辿らないと出てこない。
/// Android の TLS 検証は Java 経由で、ログも無いので、この連鎖が唯一の手がかり。
fn network_error(e: reqwest::Error) -> SyncErrorInfo {
    SyncErrorInfo::new("network", format!("Network error: {}", describe(&e)))
}

fn describe(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(": ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

/// 非成功ステータスを kind 付きエラーに変換する。
/// これを怠ると失敗したアップロードを成功扱いで同期状態に記録したり、
/// エラーレスポンスのボディをノート本文としてローカルに書き込んだりしてしまう。
async fn check_status(
    resp: reqwest::Response,
    context: &str,
) -> Result<reqwest::Response, SyncErrorInfo> {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(SyncErrorInfo::new(
            "notAuthenticated",
            "The server rejected the login. Log in again from Settings.",
        ));
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(SyncErrorInfo::other(format!(
            "{context} failed ({status}): {text}"
        )));
    }
    Ok(resp)
}

// ──────────── Tauri commands ────────────

/// panic やキャンセルでも `is_syncing` を確実に false へ戻すガード
struct SyncingGuard<'a>(&'a AtomicBool);

impl Drop for SyncingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub(crate) async fn sync_start(
    handle: AppHandle,
    state: State<'_, AppSyncState>,
) -> Result<SyncResult, SyncErrorInfo> {
    if state
        .is_syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(SyncErrorInfo::new("busy", "Sync already in progress"));
    }
    let _guard = SyncingGuard(&state.is_syncing);

    let result = do_sync(&handle).await;

    match &result {
        Ok(sync_result) => {
            *state
                .last_synced_at
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(Utc::now());
            *state
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = None;
            let _ = handle.emit(EVENT_SYNC_COMPLETE, sync_result);
        }
        Err(err) => {
            *state
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(err.message.clone());
            let _ = handle.emit(EVENT_SYNC_ERROR, err);
        }
    }

    result
}

#[tauri::command]
pub(crate) fn sync_status(state: State<'_, AppSyncState>) -> SyncStatusInfo {
    SyncStatusInfo {
        is_syncing: state.is_syncing.load(Ordering::SeqCst),
        last_synced_at: *state
            .last_synced_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner),
        last_error: state
            .last_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone(),
    }
}

// ──────────── Sync orchestration ────────────

async fn do_sync(handle: &AppHandle) -> Result<SyncResult, SyncErrorInfo> {
    let base_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| SyncErrorInfo::other(e.to_string()))?;
    let config = auth::SyncConfig::load(&base_dir);
    if !config.is_configured() {
        return Err(SyncErrorInfo::new(
            "notConfigured",
            "Sync is not set up. Add your Workers URL in Settings.",
        ));
    }
    let token = auth::get_token(&base_dir)
        .map_err(SyncErrorInfo::other)?
        .ok_or_else(|| {
            SyncErrorInfo::new("notAuthenticated", "Not logged in. Log in from Settings.")
        })?;
    if !auth::is_token_valid(&token) {
        return Err(SyncErrorInfo::new(
            "notAuthenticated",
            "Login expired. Log in again from Settings.",
        ));
    }

    let client = HttpClient::new(config.workers_url, token)?;

    // 他端末と同時に同期すると CAS で弾かれる。ユーザーに再試行させる理由はないので
    // 取得し直して自動でやり直す
    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let outcome = sync_once(&client, &base_dir).await;
        let retryable =
            matches!(&outcome, Err(err) if err.kind == "conflict") && attempt < MAX_SYNC_ATTEMPTS;
        if !retryable {
            return outcome;
        }
    }
    unreachable!("the loop returns on its last attempt")
}

const MAX_SYNC_ATTEMPTS: usize = 3;

async fn sync_once(client: &HttpClient, base_dir: &Path) -> Result<SyncResult, SyncErrorInfo> {
    let server_state = client.get_sync_state().await?;

    let local_files =
        scan::scan_local_files(base_dir).map_err(|e| SyncErrorInfo::other(e.to_string()))?;
    let local_state = SyncState::load(base_dir).map_err(|e| SyncErrorInfo::other(e.to_string()))?;

    let remote_files = server_state_to_remote_files(&server_state);
    let actions = diff::compute(&local_files, &remote_files, &local_state);

    refuse_wholesale_local_deletion(&actions, &local_files)?;

    let data_dir = magical_merchant_core::utils::paths::data_dir(base_dir);
    let mut result = SyncResult::default();
    let bulk_req = build_bulk_request(
        &actions,
        &local_files,
        &data_dir,
        server_state.etag.clone(),
        &mut result,
    )
    .map_err(SyncErrorInfo::other)?;

    let bulk_resp = client.bulk(bulk_req).await?;

    apply_response(&bulk_resp, &actions, &data_dir, &mut result).map_err(SyncErrorInfo::other)?;

    // サーバーが確定させた状態をそのままローカルにも記録する。
    // ここでローカルを再スキャンして組み直すと、ダウンロード直後の mtime が
    // サーバーの版と食い違い、同じファイルを永久に再取得し続ける

    save_local_state(base_dir, &bulk_resp.new_state, &data_dir).map_err(SyncErrorInfo::other)?;

    Ok(result)
}

/// これ以下ならユーザーが本当に消したと考えて素通しする。
/// 1〜2件の全消しは事故が起きても取り返しがつく
const WHOLESALE_DELETION_THRESHOLD: usize = 3;

/// サーバーの同期状態が壊れて空になっていると、差分計算にはローカル全消しに見える。
/// 1回の同期で手元のノートが全部消えるのはまず意図された結果ではないので止める。
fn refuse_wholesale_local_deletion(
    actions: &[SyncAction],
    local_files: &[LocalFile],
) -> Result<(), SyncErrorInfo> {
    if local_files.len() < WHOLESALE_DELETION_THRESHOLD {
        return Ok(());
    }
    let deletions = actions
        .iter()
        .filter(|a| matches!(a, SyncAction::DeleteLocal { .. }))
        .count();
    if deletions < local_files.len() {
        return Ok(());
    }
    Err(SyncErrorInfo::new(
        "unsafeDeletion",
        format!(
            "Sync stopped: the server reports every one of your {deletions} local files as deleted. \
             If that is really what you want, delete .sync-state.json in the app data directory and sync again."
        ),
    ))
}

fn server_state_to_remote_files(state: &ServerSyncState) -> Vec<RemoteFile> {
    state
        .files
        .iter()
        .filter_map(|(key, rec)| {
            let last_modified: DateTime<Utc> = rec.last_modified.parse().ok()?;
            Some(RemoteFile {
                key: key.clone(),
                last_modified,
                content_hash: rec.hash.clone(),
            })
        })
        .collect()
}

fn is_safe_key(key: &str) -> bool {
    !key.contains("..") && !key.contains('\0') && !key.starts_with('/')
}

fn build_bulk_request(
    actions: &[SyncAction],
    local_files: &[LocalFile],
    data_dir: &Path,
    expected_etag: Option<String>,
    result: &mut SyncResult,
) -> Result<BulkRequest, String> {
    let local_map: std::collections::HashMap<&str, &LocalFile> =
        local_files.iter().map(|f| (f.key.as_str(), f)).collect();

    let mut uploads: Vec<WireUpload> = Vec::new();
    let mut downloads: Vec<String> = Vec::new();
    let mut delete_remote: Vec<String> = Vec::new();
    let mut conflicts: Vec<WireConflictOp> = Vec::new();

    for action in actions {
        let key = action_key(action);
        if !is_safe_key(key) {
            result.errors.push(format!("unsafe key rejected: {key}"));
            continue;
        }

        match action {
            SyncAction::UploadNew { key } | SyncAction::UploadModified { key } => {
                let local = local_map
                    .get(key.as_str())
                    .ok_or_else(|| format!("missing local file for upload: {key}"))?;
                let content =
                    fs::read(data_dir.join(key)).map_err(|e| format!("read {key}: {e}"))?;
                uploads.push(WireUpload {
                    key: key.clone(),
                    content_base64: B64.encode(&content),
                    last_modified: local.last_modified.to_rfc3339(),
                    hash: local.content_hash.clone(),
                });
            }
            SyncAction::DownloadNew { key } | SyncAction::DownloadModified { key } => {
                downloads.push(key.clone());
            }
            SyncAction::DeleteRemote { key } => {
                delete_remote.push(key.clone());
            }
            SyncAction::DeleteLocal { key: _ } => {
                // ローカル削除は client 側だけで完結（bulk request には含めない）
            }
            SyncAction::Conflict { key } => {
                // 双方が変わっていたらローカルを採用する。捨てたほうも競合コピーとして
                // 残るので、どちらの編集も失われない
                let local = local_map
                    .get(key.as_str())
                    .ok_or_else(|| format!("missing local file for conflict: {key}"))?;
                let content = fs::read(data_dir.join(key))
                    .map_err(|e| format!("read conflict {key}: {e}"))?;
                conflicts.push(WireConflictOp {
                    key: key.clone(),
                    conflict_key: conflict::conflict_filename(key, Utc::now()),
                    content_base64: B64.encode(&content),
                    hash: local.content_hash.clone(),
                    last_modified: local.last_modified.to_rfc3339(),
                });
            }
        }
    }

    Ok(BulkRequest {
        uploads,
        downloads,
        delete_remote,
        conflicts,
        expected_etag,
    })
}

fn write_under(data_dir: &Path, key: &str, content: &[u8]) -> Result<(), String> {
    if !is_safe_key(key) {
        return Err(format!("unsafe key from server: {key}"));
    }
    let path = data_dir.join(key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {key}: {e}"))?;
    }
    // 直接上書きだと、ダウンロード書き込み中のクラッシュで手元のメモが
    // 半分だけ書けたファイルに置き換わる
    magical_merchant_core::utils::fs::write_atomic(&path, content)
        .map_err(|e| format!("write {key}: {e}"))
}

fn decode(file: &DownloadedFile) -> Result<Vec<u8>, String> {
    B64.decode(&file.content_base64)
        .map_err(|e| format!("base64 decode {}: {e}", file.key))
}

fn apply_response(
    bulk_resp: &BulkResponse,
    actions: &[SyncAction],
    data_dir: &Path,
    result: &mut SyncResult,
) -> Result<(), String> {
    for d in &bulk_resp.downloads {
        write_under(data_dir, &d.key, &decode(d)?)?;
        result.downloaded += 1;
    }

    // 競合で負けたリモート側。`.sync-conflict-` はスキャン対象外なので、
    // ローカルに置いても同期ループにはならない
    for d in &bulk_resp.conflict_downloads {
        write_under(data_dir, &d.key, &decode(d)?)?;
    }

    for action in actions {
        match action {
            SyncAction::UploadNew { .. } | SyncAction::UploadModified { .. } => {
                result.uploaded += 1;
            }
            SyncAction::DeleteRemote { .. } => {
                result.deleted_remote += 1;
            }
            SyncAction::Conflict { .. } => {
                result.conflicts += 1;
            }
            SyncAction::DeleteLocal { key } => {
                let path = data_dir.join(key);
                if path.exists() {
                    if let Err(e) = fs::remove_file(&path) {
                        result.errors.push(format!("delete_local {key}: {e}"));
                    } else {
                        result.deleted_local += 1;
                    }
                } else {
                    result.deleted_local += 1;
                }
            }
            SyncAction::DownloadNew { .. } | SyncAction::DownloadModified { .. } => {}
        }
    }

    Ok(())
}

/// サーバーが確定させた状態を、実際に手元にあるファイルだけに絞って保存する。
/// 手元に無いものを「同期済み」と記録すると、次の同期でリモート側を消してしまう。
fn to_local_state(server_state: &ServerSyncState, data_dir: &Path) -> SyncState {
    let mut state = SyncState {
        last_sync: Some(Utc::now()),
        ..Default::default()
    };
    for (key, record) in &server_state.files {
        let Ok(last_synced_modified) = record.last_modified.parse() else {
            continue;
        };
        if !is_safe_key(key) || !data_dir.join(key).exists() {
            continue;
        }
        state.files.insert(
            key.clone(),
            FileSyncRecord {
                last_synced_modified,
                content_hash: record.hash.clone(),
            },
        );
    }
    state
}

fn save_local_state(
    base_dir: &Path,
    server_state: &ServerSyncState,
    data_dir: &Path,
) -> Result<(), String> {
    to_local_state(server_state, data_dir)
        .save(base_dir)
        .map_err(|e| e.to_string())
}

fn action_key(action: &SyncAction) -> &str {
    match action {
        SyncAction::UploadNew { key }
        | SyncAction::UploadModified { key }
        | SyncAction::DownloadNew { key }
        | SyncAction::DownloadModified { key }
        | SyncAction::DeleteRemote { key }
        | SyncAction::DeleteLocal { key }
        | SyncAction::Conflict { key } => key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_error_is_tagged_so_ui_can_ignore_it() {
        let info = SyncErrorInfo::new("busy", "Sync already in progress");
        assert_eq!(info.kind, "busy");
    }

    #[test]
    fn other_errors_keep_message() {
        let info = SyncErrorInfo::other("boom");
        assert_eq!(info.kind, "other");
        assert!(info.message.contains("boom"));
    }

    #[test]
    fn describe_walks_the_source_chain() {
        #[derive(Debug)]
        struct Outer(std::io::Error);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("error sending request")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let inner = std::io::Error::other("invalid peer certificate: UnknownIssuer");
        assert_eq!(
            describe(&Outer(inner)),
            "error sending request: invalid peer certificate: UnknownIssuer"
        );
    }

    #[test]
    fn syncing_guard_clears_flag_on_drop() {
        let flag = AtomicBool::new(true);
        {
            let _guard = SyncingGuard(&flag);
        }
        assert!(!flag.load(Ordering::SeqCst));
    }

    fn local_file(key: &str, hash: &str) -> LocalFile {
        LocalFile {
            key: key.to_string(),
            last_modified: "2026-08-05T00:00:00Z".parse().unwrap(),
            content_hash: hash.to_string(),
        }
    }

    fn server_state(entries: &[(&str, &str, &str)]) -> ServerSyncState {
        ServerSyncState {
            files: entries
                .iter()
                .map(|(key, hash, last_modified)| {
                    (
                        (*key).to_string(),
                        ServerFileRecord {
                            hash: (*hash).to_string(),
                            last_modified: (*last_modified).to_string(),
                        },
                    )
                })
                .collect(),
            last_sync: None,
            etag: None,
        }
    }

    fn seed(data_dir: &Path, key: &str, content: &str) {
        let path = data_dir.join(key);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// ハッシュが欠けたアップロードはサーバーが 400 で弾く
    #[test]
    fn upload_carries_the_local_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "hello");
        let locals = vec![local_file("notes/a.md", "deadbeef")];
        let actions = vec![SyncAction::UploadNew {
            key: "notes/a.md".to_string(),
        }];

        let mut result = SyncResult::default();
        let req = build_bulk_request(&actions, &locals, dir.path(), None, &mut result).unwrap();

        assert_eq!(req.uploads.len(), 1);
        assert_eq!(req.uploads[0].hash, "deadbeef");
        assert_eq!(req.uploads[0].content_base64, B64.encode(b"hello"));
    }

    #[test]
    fn conflict_sends_local_content_so_the_local_edit_wins() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "local edit");
        let locals = vec![local_file("notes/a.md", "hash-local")];
        let actions = vec![SyncAction::Conflict {
            key: "notes/a.md".to_string(),
        }];

        let mut result = SyncResult::default();
        let req = build_bulk_request(&actions, &locals, dir.path(), None, &mut result).unwrap();

        assert_eq!(req.conflicts.len(), 1);
        assert_eq!(req.conflicts[0].hash, "hash-local");
        assert_eq!(req.conflicts[0].content_base64, B64.encode(b"local edit"));
        assert!(req.conflicts[0].conflict_key.contains(".sync-conflict-"));
    }

    #[test]
    fn local_state_mirrors_what_the_server_recorded() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "content");
        let state = server_state(&[("notes/a.md", "hash-a", "2026-08-05T00:00:00Z")]);

        let local = to_local_state(&state, dir.path());

        let record = &local.files["notes/a.md"];
        assert_eq!(record.content_hash, "hash-a");
        assert_eq!(
            record.last_synced_modified,
            "2026-08-05T00:00:00Z".parse::<DateTime<Utc>>().unwrap()
        );
    }

    /// 手元に無いファイルを「同期済み」と記録すると、次の同期で
    /// リモート側が削除扱いになって消える
    #[test]
    fn local_state_drops_files_that_are_not_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let state = server_state(&[("notes/missing.md", "hash-a", "2026-08-05T00:00:00Z")]);

        assert!(to_local_state(&state, dir.path()).files.is_empty());
    }

    #[test]
    fn local_state_drops_unsafe_keys() {
        let dir = tempfile::tempdir().unwrap();
        let state = server_state(&[("../escape.md", "hash-a", "2026-08-05T00:00:00Z")]);

        assert!(to_local_state(&state, dir.path()).files.is_empty());
    }

    #[test]
    fn applying_the_response_writes_downloads_and_conflict_copies() {
        let dir = tempfile::tempdir().unwrap();
        let resp = BulkResponse {
            downloads: vec![DownloadedFile {
                key: "notes/a.md".to_string(),
                content_base64: B64.encode(b"remote"),
            }],
            conflict_downloads: vec![DownloadedFile {
                key: "notes/a.sync-conflict-20260805-000000.md".to_string(),
                content_base64: B64.encode(b"other device"),
            }],
            new_state: server_state(&[]),
        };

        let mut result = SyncResult::default();
        apply_response(&resp, &[], dir.path(), &mut result).unwrap();

        assert_eq!(
            fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "remote"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("notes/a.sync-conflict-20260805-000000.md"))
                .unwrap(),
            "other device"
        );
        assert_eq!(result.downloaded, 1);
    }

    fn delete_local(key: &str) -> SyncAction {
        SyncAction::DeleteLocal {
            key: key.to_string(),
        }
    }

    /// サーバーの同期状態が壊れて空になったときに、それを「全部削除された」と
    /// 解釈してノートを消してしまうのを防ぐ
    #[test]
    fn refuses_a_sync_that_would_delete_every_local_file() {
        let locals = vec![
            local_file("notes/a.md", "h1"),
            local_file("notes/b.md", "h2"),
            local_file("notes/c.md", "h3"),
        ];
        let actions = vec![
            delete_local("notes/a.md"),
            delete_local("notes/b.md"),
            delete_local("notes/c.md"),
        ];

        let err = refuse_wholesale_local_deletion(&actions, &locals).unwrap_err();
        assert_eq!(err.kind, "unsafeDeletion");
    }

    #[test]
    fn allows_deleting_some_of_the_local_files() {
        let locals = vec![
            local_file("notes/a.md", "h1"),
            local_file("notes/b.md", "h2"),
            local_file("notes/c.md", "h3"),
        ];
        let actions = vec![delete_local("notes/a.md"), delete_local("notes/b.md")];

        assert!(refuse_wholesale_local_deletion(&actions, &locals).is_ok());
    }

    /// 数件しか無いうちは取り返しがつくので素通しする
    #[test]
    fn allows_clearing_a_tiny_workspace() {
        let locals = vec![local_file("notes/a.md", "h1")];
        let actions = vec![delete_local("notes/a.md")];

        assert!(refuse_wholesale_local_deletion(&actions, &locals).is_ok());
    }

    #[test]
    fn applying_the_response_rejects_a_traversal_key_from_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let resp = BulkResponse {
            downloads: vec![DownloadedFile {
                key: "../escaped.md".to_string(),
                content_base64: B64.encode(b"evil"),
            }],
            conflict_downloads: Vec::new(),
            new_state: server_state(&[]),
        };

        let mut result = SyncResult::default();
        assert!(apply_response(&resp, &[], dir.path(), &mut result).is_err());
    }
}
