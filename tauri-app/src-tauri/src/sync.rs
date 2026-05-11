use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::task::JoinSet;

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

#[derive(Serialize)]
struct ClientFileEntry {
    key: String,
    hash: String,
    last_modified: String,
}

#[derive(Serialize)]
struct SyncRequest {
    files: Vec<ClientFileEntry>,
}

#[derive(Serialize)]
struct SyncAckRequest {
    files: Vec<ClientFileEntry>,
    etag: Option<String>,
}

#[derive(Deserialize)]
struct SyncPlanResponse {
    actions: Vec<SyncActionResponse>,
    etag: Option<String>,
}

#[derive(Deserialize)]
struct SyncActionResponse {
    #[serde(rename = "type")]
    action_type: String,
    key: String,
    conflict_key: Option<String>,
    resolution: Option<String>,
}

struct HttpSyncClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

fn is_safe_key(key: &str) -> bool {
    !key.contains("..") && !key.contains('\0') && !key.starts_with('/')
}

impl HttpSyncClient {
    fn new(base_url: String, token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.trim_end_matches('/').to_string(),
            token,
        }
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    async fn request_sync_plan(
        &self,
        files: Vec<ClientFileEntry>,
    ) -> Result<SyncPlanResponse, String> {
        let body = SyncRequest { files };
        let resp = self
            .http
            .post(format!("{}/sync", self.base_url))
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Sync request failed ({status}): {text}"));
        }

        resp.json()
            .await
            .map_err(|e| format!("Failed to parse sync response: {e}"))
    }

    async fn send_ack(
        &self,
        files: Vec<ClientFileEntry>,
        etag: Option<String>,
    ) -> Result<(), String> {
        let body = SyncAckRequest { files, etag };
        let resp = self
            .http
            .post(format!("{}/sync/ack", self.base_url))
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err("Sync state conflict: please retry".to_string());
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Sync ack failed ({status}): {text}"));
        }

        Ok(())
    }

    async fn download(&self, key: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .http
            .get(format!("{}/files/{}", self.base_url, key))
            .header("Authorization", self.auth_header())
            .send()
            .await
            .map_err(|e| format!("Download error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(format!("File not found: {key}"));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("Download read error: {e}"))
    }

    async fn upload(&self, key: &str, content: &[u8], last_modified: &str) -> Result<(), String> {
        let resp = self
            .http
            .put(format!("{}/files/{}", self.base_url, key))
            .header("Authorization", self.auth_header())
            .header("X-Last-Modified", last_modified)
            .body(content.to_vec())
            .send()
            .await
            .map_err(|e| format!("Upload error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        let resp = self
            .http
            .delete(format!("{}/files/{}", self.base_url, key))
            .header("Authorization", self.auth_header())
            .send()
            .await
            .map_err(|e| format!("Delete error: {e}"))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err("Not authenticated".to_string());
        }
        Ok(())
    }
}

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

    let client = Arc::new(HttpSyncClient::new(config.workers_url, token));

    // Scan local files
    let local_files = magical_merchant_core::sync::scan::scan_local_files(&base_dir)
        .map_err(|e| e.to_string())?;

    // Build lookup for local file timestamps
    let local_modified: std::collections::HashMap<String, String> = local_files
        .iter()
        .map(|f| (f.key.clone(), f.last_modified.to_rfc3339()))
        .collect();

    // Build request
    let client_files: Vec<ClientFileEntry> = local_files
        .iter()
        .map(|f| ClientFileEntry {
            key: f.key.clone(),
            hash: f.content_hash.clone(),
            last_modified: f.last_modified.to_rfc3339(),
        })
        .collect();

    // Phase 1: Request sync plan from server (read-only, no state mutation)
    let plan = client.request_sync_plan(client_files).await?;

    // Phase 2: Execute all actions concurrently
    let data_dir = magical_merchant_core::utils::paths::data_dir(&base_dir);
    let mut tasks: JoinSet<ActionResult> = JoinSet::new();

    for action in plan.actions {
        if !is_safe_key(&action.key) {
            tasks.spawn(async move {
                ActionResult::Error(format!("unsafe key rejected: {}", action.key))
            });
            continue;
        }
        if let Some(ref ck) = action.conflict_key {
            if !is_safe_key(ck) {
                let ck = ck.clone();
                tasks.spawn(async move {
                    ActionResult::Error(format!("unsafe conflict key rejected: {ck}"))
                });
                continue;
            }
        }

        let c = Arc::clone(&client);
        let dd = data_dir.clone();
        let lm = local_modified.clone();

        match action.action_type.as_str() {
            "upload" => {
                tasks.spawn(async move { execute_upload(&c, &dd, &lm, &action.key).await });
            }
            "download" => {
                tasks.spawn(async move { execute_download(&c, &dd, &action.key).await });
            }
            "delete_local" => {
                tasks.spawn(async move { execute_delete_local(&dd, &action.key) });
            }
            "delete_remote" => {
                tasks.spawn(async move { execute_delete_remote(&c, &action.key).await });
            }
            "conflict" => {
                tasks.spawn(async move {
                    execute_conflict(
                        &c,
                        &dd,
                        &lm,
                        &action.key,
                        action.conflict_key.as_deref().unwrap_or(""),
                        action.resolution.as_deref().unwrap_or("keep_remote"),
                    )
                    .await
                });
            }
            unknown => {
                let msg = format!("unknown action type: {unknown}");
                tasks.spawn(async move { ActionResult::Error(msg) });
            }
        }
    }

    let mut result = SyncResult::default();
    while let Some(join_result) = tasks.join_next().await {
        match join_result {
            Ok(ActionResult::Uploaded) => result.uploaded += 1,
            Ok(ActionResult::Downloaded) => result.downloaded += 1,
            Ok(ActionResult::DeletedLocal) => result.deleted_local += 1,
            Ok(ActionResult::DeletedRemote) => result.deleted_remote += 1,
            Ok(ActionResult::Conflict) => result.conflicts += 1,
            Ok(ActionResult::Error(e)) => result.errors.push(e),
            Err(e) => result.errors.push(format!("task panic: {e}")),
        }
    }

    // Phase 3: Ack — re-scan and report actual state to server
    let updated_files = magical_merchant_core::sync::scan::scan_local_files(&base_dir)
        .map_err(|e| e.to_string())?;

    let ack_files: Vec<ClientFileEntry> = updated_files
        .iter()
        .map(|f| ClientFileEntry {
            key: f.key.clone(),
            hash: f.content_hash.clone(),
            last_modified: f.last_modified.to_rfc3339(),
        })
        .collect();

    client.send_ack(ack_files, plan.etag).await?;

    // Update local sync state to match what we acked
    use magical_merchant_core::sync::state::FileSyncRecord;
    let mut new_state = magical_merchant_core::sync::state::SyncState::default();
    new_state.last_sync = Some(Utc::now());
    for f in &updated_files {
        new_state.files.insert(
            f.key.clone(),
            FileSyncRecord {
                last_synced_modified: f.last_modified,
                content_hash: f.content_hash.clone(),
            },
        );
    }
    new_state.save(&base_dir).map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppSyncState>) -> Result<SyncStatusInfo, String> {
    Ok(SyncStatusInfo {
        is_syncing: state.is_syncing.load(Ordering::SeqCst),
        last_synced_at: *state.last_synced_at.lock().unwrap(),
        last_error: state.last_error.lock().unwrap().clone(),
    })
}

enum ActionResult {
    Uploaded,
    Downloaded,
    DeletedLocal,
    DeletedRemote,
    Conflict,
    Error(String),
}

async fn execute_upload(
    client: &HttpSyncClient,
    data_dir: &PathBuf,
    local_modified: &std::collections::HashMap<String, String>,
    key: &str,
) -> ActionResult {
    let path = data_dir.join(key);
    let content = match fs::read(&path) {
        Ok(c) => c,
        Err(e) => return ActionResult::Error(format!("read {key}: {e}")),
    };
    let last_modified = local_modified
        .get(key)
        .cloned()
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    match client.upload(key, &content, &last_modified).await {
        Ok(()) => ActionResult::Uploaded,
        Err(e) => ActionResult::Error(format!("upload {key}: {e}")),
    }
}

async fn execute_download(client: &HttpSyncClient, data_dir: &PathBuf, key: &str) -> ActionResult {
    let content = match client.download(key).await {
        Ok(c) => c,
        Err(e) => return ActionResult::Error(format!("download {key}: {e}")),
    };
    let path = data_dir.join(key);
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return ActionResult::Error(format!("mkdir {key}: {e}"));
        }
    }
    match fs::write(&path, &content) {
        Ok(()) => ActionResult::Downloaded,
        Err(e) => ActionResult::Error(format!("write {key}: {e}")),
    }
}

fn execute_delete_local(data_dir: &PathBuf, key: &str) -> ActionResult {
    let path = data_dir.join(key);
    if path.exists() {
        if let Err(e) = fs::remove_file(&path) {
            return ActionResult::Error(format!("delete_local {key}: {e}"));
        }
    }
    ActionResult::DeletedLocal
}

async fn execute_delete_remote(client: &HttpSyncClient, key: &str) -> ActionResult {
    match client.delete(key).await {
        Ok(()) => ActionResult::DeletedRemote,
        Err(e) => ActionResult::Error(format!("delete_remote {key}: {e}")),
    }
}

async fn execute_conflict(
    client: &HttpSyncClient,
    data_dir: &PathBuf,
    local_modified: &std::collections::HashMap<String, String>,
    key: &str,
    conflict_key: &str,
    resolution: &str,
) -> ActionResult {
    let mut errors = Vec::new();

    match resolution {
        "keep_local" => {
            // Download remote as conflict copy, upload local
            match client.download(key).await {
                Ok(remote_content) => {
                    if !conflict_key.is_empty() {
                        let conflict_path = data_dir.join(conflict_key);
                        if let Some(parent) = conflict_path.parent() {
                            if let Err(e) = fs::create_dir_all(parent) {
                                errors.push(format!("conflict mkdir {conflict_key}: {e}"));
                            }
                        }
                        if let Err(e) = fs::write(&conflict_path, &remote_content) {
                            errors.push(format!("conflict write {conflict_key}: {e}"));
                        }
                    }
                }
                Err(e) => errors.push(format!("conflict download {key}: {e}")),
            }
            let path = data_dir.join(key);
            match fs::read(&path) {
                Ok(content) => {
                    let last_modified = local_modified
                        .get(key)
                        .cloned()
                        .unwrap_or_else(|| Utc::now().to_rfc3339());
                    if let Err(e) = client.upload(key, &content, &last_modified).await {
                        errors.push(format!("conflict upload {key}: {e}"));
                    }
                }
                Err(e) => errors.push(format!("conflict read {key}: {e}")),
            }
        }
        _ => {
            // keep_remote: save local as conflict copy, download remote
            let path = data_dir.join(key);
            if !conflict_key.is_empty() {
                match fs::read(&path) {
                    Ok(local_content) => {
                        let conflict_path = data_dir.join(conflict_key);
                        if let Some(parent) = conflict_path.parent() {
                            if let Err(e) = fs::create_dir_all(parent) {
                                errors.push(format!("conflict mkdir {conflict_key}: {e}"));
                            }
                        }
                        if let Err(e) = fs::write(&conflict_path, &local_content) {
                            errors.push(format!("conflict write {conflict_key}: {e}"));
                        }
                    }
                    Err(e) => errors.push(format!("conflict read {key}: {e}")),
                }
            }
            match client.download(key).await {
                Ok(remote_content) => {
                    if let Some(parent) = path.parent() {
                        if let Err(e) = fs::create_dir_all(parent) {
                            errors.push(format!("conflict mkdir {key}: {e}"));
                        }
                    }
                    if let Err(e) = fs::write(&path, &remote_content) {
                        errors.push(format!("conflict write {key}: {e}"));
                    }
                }
                Err(e) => errors.push(format!("conflict download {key}: {e}")),
            }
        }
    }

    if errors.is_empty() {
        ActionResult::Conflict
    } else {
        ActionResult::Error(errors.join("; "))
    }
}
