use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use magical_merchant_core::sync::client::{RemoteFile, SyncClient};
use magical_merchant_core::sync::SyncResult;
use magical_merchant_core::CoreError;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::auth;

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusInfo {
    pub is_syncing: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
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

pub struct R2SyncClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
}

impl R2SyncClient {
    pub fn new(base_url: String, token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url,
            token,
        }
    }
}

#[derive(serde::Deserialize)]
struct ListResponse {
    files: Vec<ListEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListEntry {
    key: String,
    last_modified: String,
    size: u64,
}

impl SyncClient for R2SyncClient {
    async fn list_remote(&self) -> Result<Vec<RemoteFile>, CoreError> {
        let resp = self
            .http
            .get(format!("{}/files", self.base_url))
            .header("Cf-Access-Jwt-Assertion", &self.token)
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CoreError::NotAuthenticated);
        }

        let body: ListResponse = resp
            .json()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        body.files
            .into_iter()
            .map(|entry| {
                let last_modified: DateTime<Utc> = entry
                    .last_modified
                    .parse()
                    .map_err(|e: chrono::ParseError| CoreError::Sync(e.to_string()))?;
                Ok(RemoteFile {
                    key: entry.key,
                    last_modified,
                    size: entry.size,
                })
            })
            .collect()
    }

    async fn download(&self, key: &str) -> Result<Vec<u8>, CoreError> {
        let resp = self
            .http
            .get(format!("{}/files/{}", self.base_url, key))
            .header("Cf-Access-Jwt-Assertion", &self.token)
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CoreError::NotAuthenticated);
        }

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(CoreError::NotFound(key.to_string()));
        }

        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| CoreError::Network(e.to_string()))
    }

    async fn upload(
        &self,
        key: &str,
        content: &[u8],
        last_modified: DateTime<Utc>,
    ) -> Result<(), CoreError> {
        let resp = self
            .http
            .put(format!("{}/files/{}", self.base_url, key))
            .header("Cf-Access-Jwt-Assertion", &self.token)
            .header("X-Last-Modified", last_modified.to_rfc3339())
            .body(content.to_vec())
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CoreError::NotAuthenticated);
        }

        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), CoreError> {
        let resp = self
            .http
            .delete(format!("{}/files/{}", self.base_url, key))
            .header("Cf-Access-Jwt-Assertion", &self.token)
            .send()
            .await
            .map_err(|e| CoreError::Network(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(CoreError::NotAuthenticated);
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
            let _ = handle.emit("sync-complete", sync_result);
        }
        Err(err) => {
            *state.last_error.lock().unwrap() = Some(err.clone());
            let _ = handle.emit("sync-error", err);
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

    let client = R2SyncClient::new(config.workers_url, token);
    let engine = magical_merchant_core::sync::SyncEngine::new(client, base_dir);

    engine.sync().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppSyncState>) -> Result<SyncStatusInfo, String> {
    Ok(SyncStatusInfo {
        is_syncing: state.is_syncing.load(Ordering::SeqCst),
        last_synced_at: state.last_synced_at.lock().unwrap().clone(),
        last_error: state.last_error.lock().unwrap().clone(),
    })
}
