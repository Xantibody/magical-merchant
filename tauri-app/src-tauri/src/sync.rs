//! The Tauri side of sync.
//!
//! The engine itself is in core (`magical_merchant_core::sync::engine`); what stays here is
//! only the commands, the in-progress state, the events, and building the HTTP client.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use chrono::{DateTime, Utc};
use magical_merchant_core::sync::client::HttpClient;
use magical_merchant_core::sync::config::SyncConfig;
use magical_merchant_core::sync::{SyncError, SyncResult, engine, token};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

/// The desktop build uses core's as it is. The CLI's `sync` builds from the same entry, so
/// the TLS defaults do not drift apart between the app and the CLI
#[cfg(not(target_os = "android"))]
use magical_merchant_core::sync::client::desktop_http_client as http_client;

/// Only Android bypasses the device's verifier. The reason is in `android_tls::sync_tls_config`
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

/// A guard that returns `is_syncing` to false even on a panic or a cancellation
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
            // Cleaning up duplicate IDs that came down happens inside the engine. Doing it
            // after the lock is released would move notes in the middle of the scan a
            // waiting CLI has started
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

/// Resolves the config and the token, builds the client, and hands it to core's engine.
/// `AppHandle` is used only to resolve the base dir and to branch on TLS.
async fn do_sync(handle: &AppHandle) -> Result<SyncResult, SyncError> {
    let base_dir = crate::app_base_dir(handle).map_err(SyncError::other)?;
    // The repair before the scan is done by the engine inside the lock. That also covers
    // pressing sync after looking only at Scrawl, which never went through the listing's
    // `repair_once`
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
