//! 同期の Tauri 側。エンジンそのものは core (`magical_merchant_core::sync::engine`)
//! にあり、ここに残るのは command・進行状態・イベント、そして HTTP クライアントの
//! 組み立てだけ。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use chrono::{DateTime, Utc};
use magical_merchant_core::sync::client::HttpClient;
use magical_merchant_core::sync::config::SyncConfig;
use magical_merchant_core::sync::{SyncError, SyncResult, engine, token};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_SYNC_COMPLETE: &str = "sync-complete";
const EVENT_SYNC_ERROR: &str = "sync-error";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SyncStatusInfo {
    pub is_syncing: bool,
    pub last_synced_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
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

// ──────────── HTTP client ────────────

/// `Client::new()` は組み立てに失敗すると panic する。同期はユーザーの操作で
/// 走るので、TLS の初期化がこけても落とさずエラーとして返す
#[cfg(not(target_os = "android"))]
fn http_client() -> Result<reqwest::Client, SyncError> {
    use magical_merchant_core::sync::client::describe;

    reqwest::Client::builder()
        .build()
        .map_err(|e| SyncError::other(format!("HTTP client setup failed: {}", describe(&e))))
}

/// Android だけ端末の検証器を迂回する。理由は `android_tls::sync_tls_config`
#[cfg(target_os = "android")]
fn http_client() -> Result<reqwest::Client, SyncError> {
    use magical_merchant_core::sync::client::describe;

    let tls = crate::android_tls::sync_tls_config()
        .map_err(|e| SyncError::other(format!("TLS setup failed: {e}")))?;
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .build()
        .map_err(|e| SyncError::other(format!("HTTP client setup failed: {}", describe(&e))))
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
) -> Result<SyncResult, SyncError> {
    if state
        .is_syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(SyncError::new("busy", "Sync already in progress"));
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

/// 設定とトークンを解いてクライアントを組み、core のエンジンに渡す。
/// `AppHandle` を使うのは base dir の解決と TLS の分岐だけ。
async fn do_sync(handle: &AppHandle) -> Result<SyncResult, SyncError> {
    let base_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| SyncError::other(e.to_string()))?;
    // タイムラインだけ見て同期を押すと、ノート一覧より先にここへ来る。
    // 走査より前に競合コピーを `data/` の外へ出しておかないと、残骸が
    // 新しいノートとして全端末へ配られる
    crate::repair_once(&base_dir);

    let config = SyncConfig::load(&base_dir)?.unwrap_or_default();
    if !config.is_configured() {
        return Err(SyncError::new(
            "notConfigured",
            "Sync is not set up. Add your Workers URL in Settings.",
        ));
    }
    let token = token::get_token(&base_dir)
        .map_err(SyncError::other)?
        .ok_or_else(|| {
            SyncError::new("notAuthenticated", "Not logged in. Log in from Settings.")
        })?;
    if !token::is_token_valid(&token) {
        return Err(SyncError::new(
            "notAuthenticated",
            "Login expired. Log in again from Settings.",
        ));
    }

    let client = HttpClient::new(http_client()?, &config.workers_url, &token);

    engine::run(&client, &base_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn syncing_guard_clears_flag_on_drop() {
        let flag = AtomicBool::new(true);
        {
            let _guard = SyncingGuard(&flag);
        }
        assert!(!flag.load(Ordering::SeqCst));
    }
}
