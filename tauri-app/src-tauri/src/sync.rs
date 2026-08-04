use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

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
pub struct SyncStatusInfo {
    pub is_syncing: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

pub struct AppSyncState {
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

#[derive(Deserialize)]
struct ServerSyncState {
    files: std::collections::HashMap<String, ServerFileRecord>,
    #[allow(dead_code)]
    last_sync: Option<String>,
    etag: Option<String>,
}

#[derive(Deserialize)]
struct ServerFileRecord {
    hash: String,
    last_modified: String,
}

#[derive(Serialize)]
struct WireSyncState {
    files: std::collections::HashMap<String, WireFileRecord>,
    last_sync: String,
}

#[derive(Serialize)]
struct WireFileRecord {
    hash: String,
    last_modified: String,
}

#[derive(Serialize)]
struct WireFileContent {
    key: String,
    content_base64: String,
    last_modified: String,
}

#[derive(Serialize)]
struct WireConflictOp {
    key: String,
    conflict_key: String,
    resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_base64: Option<String>,
}

#[derive(Serialize)]
struct BulkRequest {
    uploads: Vec<WireFileContent>,
    downloads: Vec<String>,
    delete_remote: Vec<String>,
    conflicts: Vec<WireConflictOp>,
    new_state: WireSyncState,
    expected_etag: Option<String>,
}

#[derive(Deserialize)]
struct BulkResponse {
    downloads: Vec<DownloadedFile>,
}

#[derive(Deserialize)]
struct DownloadedFile {
    key: String,
    content_base64: String,
}

// ──────────── HTTP client ────────────

struct HttpClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl HttpClient {
    fn new(base_url: String, token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        }
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    async fn get_sync_state(&self) -> Result<ServerSyncState, String> {
        let resp = self
            .http
            .get(format!("{}/sync-state", self.base_url))
            .header("Authorization", self.auth())
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("get_sync_state failed ({status}): {text}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse sync state: {e}"))
    }

    async fn bulk(&self, req: BulkRequest) -> Result<BulkResponse, String> {
        let resp = self
            .http
            .post(format!("{}/sync/bulk", self.base_url))
            .header("Authorization", self.auth())
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err("Sync state changed concurrently, please retry".to_string());
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("bulk failed ({status}): {text}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse bulk response: {e}"))
    }
}

// ──────────── Tauri commands ────────────

#[tauri::command]
pub async fn sync_start(
    handle: AppHandle,
    state: State<'_, AppSyncState>,
) -> Result<SyncResult, String> {
    if state
        .is_syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Sync already in progress".to_string());
    }

    let result = do_sync(&handle).await;

    state.is_syncing.store(false, Ordering::SeqCst);

    match &result {
        Ok(sync_result) => {
            *state.last_synced_at.lock().unwrap() = Some(Utc::now());
            *state.last_error.lock().unwrap() = None;
            let _ = handle.emit(EVENT_SYNC_COMPLETE, sync_result);
        }
        Err(err) => {
            *state.last_error.lock().unwrap() = Some(err.clone());
            let _ = handle.emit(EVENT_SYNC_ERROR, err);
        }
    }

    result
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppSyncState>) -> Result<SyncStatusInfo, String> {
    Ok(SyncStatusInfo {
        is_syncing: state.is_syncing.load(Ordering::SeqCst),
        last_synced_at: *state.last_synced_at.lock().unwrap(),
        last_error: state.last_error.lock().unwrap().clone(),
    })
}

// ──────────── Sync orchestration ────────────

async fn do_sync(handle: &AppHandle) -> Result<SyncResult, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = auth::SyncConfig::load(&base_dir);
    if !config.is_configured() {
        return Err("Sync not configured".to_string());
    }
    let token = auth::get_token()?.ok_or("Not authenticated")?;
    if !auth::is_token_valid(&token) {
        return Err("Token expired. Please re-authenticate.".to_string());
    }

    let client = HttpClient::new(config.workers_url, token);

    // 1. Server state を1リクエストで取得
    let server_state = client.get_sync_state().await?;

    // 2. ローカルスキャン
    let local_files = scan::scan_local_files(&base_dir).map_err(|e| e.to_string())?;
    let local_state = SyncState::load(&base_dir).map_err(|e| e.to_string())?;

    // 3. Rust core で diff 計算
    let remote_files = server_state_to_remote_files(&server_state);
    let actions = diff::compute(&local_files, &remote_files, &local_state);

    // 4. アクションを bulk request に変換
    let data_dir = magical_merchant_core::utils::paths::data_dir(&base_dir);
    let mut result = SyncResult::default();
    let bulk_req = build_bulk_request(
        &actions,
        &local_files,
        &data_dir,
        server_state.etag.clone(),
        &mut result,
    )?;

    // 5. 一括実行
    let bulk_resp = client.bulk(bulk_req).await?;

    // 6. downloads + conflict ローカル書き込み
    apply_downloads(&bulk_resp, &actions, &data_dir, &mut result)?;

    // 7. ローカル sync state 更新
    save_local_state(&base_dir)?;

    Ok(result)
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

    let mut uploads: Vec<WireFileContent> = Vec::new();
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
                uploads.push(WireFileContent {
                    key: key.clone(),
                    content_base64: B64.encode(&content),
                    last_modified: local.last_modified.to_rfc3339(),
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
                // conflict 解決ロジック: LWW
                let local = local_map.get(key.as_str());
                // remote の last_modified は server_state から…
                // 簡略化: local があれば last_modified を local 側として比較できないので
                // 単純に local 優先（後で改善余地あり）
                let conflict_key = conflict::conflict_filename(key, Utc::now());

                if local.is_some() {
                    let content = fs::read(data_dir.join(key))
                        .map_err(|e| format!("read conflict {key}: {e}"))?;
                    conflicts.push(WireConflictOp {
                        key: key.clone(),
                        conflict_key,
                        resolution: "keep_local".to_string(),
                        content_base64: Some(B64.encode(&content)),
                    });
                } else {
                    conflicts.push(WireConflictOp {
                        key: key.clone(),
                        conflict_key,
                        resolution: "keep_remote".to_string(),
                        content_base64: None,
                    });
                }
            }
        }
    }

    // new_state: ローカルの現在のファイル一覧（upload 後の状態を仮想的に表現）
    // 実際は bulk が成功した後にローカル scan + state 保存するが、
    // ここでは local_files をそのまま new_state として送る（簡易版）
    let mut new_files_map = std::collections::HashMap::new();
    for f in local_files {
        new_files_map.insert(
            f.key.clone(),
            WireFileRecord {
                hash: f.content_hash.clone(),
                last_modified: f.last_modified.to_rfc3339(),
            },
        );
    }

    Ok(BulkRequest {
        uploads,
        downloads,
        delete_remote,
        conflicts,
        new_state: WireSyncState {
            files: new_files_map,
            last_sync: Utc::now().to_rfc3339(),
        },
        expected_etag,
    })
}

fn apply_downloads(
    bulk_resp: &BulkResponse,
    actions: &[SyncAction],
    data_dir: &Path,
    result: &mut SyncResult,
) -> Result<(), String> {
    // action map for distinguishing normal download vs conflict (keep_remote)
    let conflict_keys: std::collections::HashSet<String> = actions
        .iter()
        .filter_map(|a| match a {
            SyncAction::Conflict { key } => Some(key.clone()),
            _ => None,
        })
        .collect();

    // For conflicts where we chose keep_remote, the server returned remote content.
    // We need to first save current local as conflict_key, then overwrite with remote.
    // For uploads, we don't get downloads back.
    // For normal downloads, just write.

    let now = Utc::now();
    for d in &bulk_resp.downloads {
        let content = B64
            .decode(&d.content_base64)
            .map_err(|e| format!("base64 decode {}: {e}", d.key))?;
        let path = data_dir.join(&d.key);

        if conflict_keys.contains(&d.key) {
            // Save current local content as conflict copy before overwriting
            if path.exists() {
                let local_content =
                    fs::read(&path).map_err(|e| format!("read local conflict {}: {e}", d.key))?;
                let conflict_key = conflict::conflict_filename(&d.key, now);
                let conflict_path = data_dir.join(&conflict_key);
                if let Some(parent) = conflict_path.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir conflict {conflict_key}: {e}"))?;
                }
                fs::write(&conflict_path, &local_content)
                    .map_err(|e| format!("write conflict {conflict_key}: {e}"))?;
            }
            // Overwrite with remote content
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", d.key))?;
            }
            fs::write(&path, &content).map_err(|e| format!("write {}: {e}", d.key))?;
            result.conflicts += 1;
        } else {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", d.key))?;
            }
            fs::write(&path, &content).map_err(|e| format!("write {}: {e}", d.key))?;
            result.downloaded += 1;
        }
    }

    // Count uploads, deletes, and apply delete_local
    for action in actions {
        match action {
            SyncAction::UploadNew { .. } | SyncAction::UploadModified { .. } => {
                result.uploaded += 1;
            }
            SyncAction::DeleteRemote { .. } => {
                result.deleted_remote += 1;
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
            SyncAction::Conflict { key } => {
                // For keep_local conflicts, the server processed it; count here
                // For keep_remote conflicts, counted already in download loop above
                // To avoid double-count, only count if not in downloads
                let in_downloads = bulk_resp.downloads.iter().any(|d| &d.key == key);
                if !in_downloads {
                    result.conflicts += 1;
                }
            }
            _ => {}
        }
    }

    Ok(())
}

fn save_local_state(base_dir: &Path) -> Result<(), String> {
    let updated_files = scan::scan_local_files(base_dir).map_err(|e| e.to_string())?;
    let mut new_state = SyncState {
        last_sync: Some(Utc::now()),
        ..Default::default()
    };
    for f in &updated_files {
        new_state.files.insert(
            f.key.clone(),
            FileSyncRecord {
                last_synced_modified: f.last_modified,
                content_hash: f.content_hash.clone(),
            },
        );
    }
    new_state.save(base_dir).map_err(|e| e.to_string())?;
    Ok(())
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
