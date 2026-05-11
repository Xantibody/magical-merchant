use std::fs;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{DateTime, Utc};
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

#[derive(Serialize)]
struct ClientFileEntry {
    key: String,
    hash: String,
    last_modified: String,
}

#[derive(Serialize)]
struct SyncRequest {
    files: Vec<ClientFileEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_sync: Option<String>,
}

#[derive(Deserialize)]
struct SyncPlanResponse {
    actions: Vec<SyncActionResponse>,
    sync_token: String,
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

impl HttpSyncClient {
    fn new(base_url: String, token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url,
            token,
        }
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.token)
    }

    async fn request_sync_plan(
        &self,
        files: Vec<ClientFileEntry>,
        last_sync: Option<String>,
    ) -> Result<SyncPlanResponse, String> {
        let body = SyncRequest { files, last_sync };
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
        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Err("Sync conflict: please retry".to_string());
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

    let client = HttpSyncClient::new(config.workers_url, token);

    // Scan local files
    let local_files = magical_merchant_core::sync::scan::scan_local_files(&base_dir)
        .map_err(|e| e.to_string())?;

    // Load local sync state for last_sync timestamp
    let local_state = magical_merchant_core::sync::state::SyncState::load(&base_dir)
        .map_err(|e| e.to_string())?;

    // Build request
    let client_files: Vec<ClientFileEntry> = local_files
        .iter()
        .map(|f| ClientFileEntry {
            key: f.key.clone(),
            hash: f.content_hash.clone(),
            last_modified: f.last_modified.to_rfc3339(),
        })
        .collect();

    let last_sync = local_state.last_sync.map(|t| t.to_rfc3339());

    // Request sync plan from server
    let plan = client.request_sync_plan(client_files, last_sync).await?;

    // Execute the plan
    let data_dir = magical_merchant_core::utils::paths::data_dir(&base_dir);
    let mut result = SyncResult::default();

    for action in &plan.actions {
        match action.action_type.as_str() {
            "upload" => {
                let path = data_dir.join(&action.key);
                match fs::read(&path) {
                    Ok(content) => {
                        let local = local_files.iter().find(|f| f.key == action.key);
                        let last_modified = local
                            .map(|f| f.last_modified.to_rfc3339())
                            .unwrap_or_else(|| Utc::now().to_rfc3339());
                        match client.upload(&action.key, &content, &last_modified).await {
                            Ok(()) => result.uploaded += 1,
                            Err(e) => result.errors.push(format!("upload {}: {e}", action.key)),
                        }
                    }
                    Err(e) => result.errors.push(format!("read {}: {e}", action.key)),
                }
            }
            "download" => match client.download(&action.key).await {
                Ok(content) => {
                    let path = data_dir.join(&action.key);
                    if let Some(parent) = path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    match fs::write(&path, &content) {
                        Ok(()) => result.downloaded += 1,
                        Err(e) => {
                            result.errors.push(format!("write {}: {e}", action.key));
                        }
                    }
                }
                Err(e) => result.errors.push(format!("download {}: {e}", action.key)),
            },
            "delete_local" => {
                let path = data_dir.join(&action.key);
                if path.exists() {
                    if let Err(e) = fs::remove_file(&path) {
                        result
                            .errors
                            .push(format!("delete_local {}: {e}", action.key));
                    } else {
                        result.deleted_local += 1;
                    }
                } else {
                    result.deleted_local += 1;
                }
            }
            "delete_remote" => match client.delete(&action.key).await {
                Ok(()) => result.deleted_remote += 1,
                Err(e) => result
                    .errors
                    .push(format!("delete_remote {}: {e}", action.key)),
            },
            "conflict" => {
                let resolution = action.resolution.as_deref().unwrap_or("keep_remote");
                let conflict_key = action.conflict_key.as_deref().unwrap_or("");

                match resolution {
                    "keep_local" => {
                        // Download remote as conflict copy, upload local
                        if let Ok(remote_content) = client.download(&action.key).await {
                            if !conflict_key.is_empty() {
                                let conflict_path = data_dir.join(conflict_key);
                                if let Some(parent) = conflict_path.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                let _ = fs::write(&conflict_path, &remote_content);
                            }
                        }
                        let path = data_dir.join(&action.key);
                        if let Ok(content) = fs::read(&path) {
                            let local = local_files.iter().find(|f| f.key == action.key);
                            let last_modified = local
                                .map(|f| f.last_modified.to_rfc3339())
                                .unwrap_or_else(|| Utc::now().to_rfc3339());
                            let _ = client.upload(&action.key, &content, &last_modified).await;
                        }
                        result.conflicts += 1;
                    }
                    _ => {
                        // keep_remote: save local as conflict copy, download remote
                        let path = data_dir.join(&action.key);
                        if !conflict_key.is_empty() {
                            if let Ok(local_content) = fs::read(&path) {
                                let conflict_path = data_dir.join(conflict_key);
                                if let Some(parent) = conflict_path.parent() {
                                    let _ = fs::create_dir_all(parent);
                                }
                                let _ = fs::write(&conflict_path, &local_content);
                            }
                        }
                        if let Ok(remote_content) = client.download(&action.key).await {
                            if let Some(parent) = path.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let _ = fs::write(&path, &remote_content);
                        }
                        result.conflicts += 1;
                    }
                }
            }
            _ => {}
        }
    }

    // Update local sync state
    let mut new_state = local_state;
    new_state.last_sync = Some(
        plan.sync_token
            .parse::<DateTime<Utc>>()
            .unwrap_or_else(|_| Utc::now()),
    );
    // Re-scan to update file hashes after sync
    if let Ok(updated_files) = magical_merchant_core::sync::scan::scan_local_files(&base_dir) {
        use magical_merchant_core::sync::state::FileSyncRecord;
        new_state.files.clear();
        for f in &updated_files {
            new_state.files.insert(
                f.key.clone(),
                FileSyncRecord {
                    last_synced_modified: f.last_modified,
                    content_hash: f.content_hash.clone(),
                },
            );
        }
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
