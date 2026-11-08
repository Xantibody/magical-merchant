//! The Tauri side of sync.
//!
//! The engine itself is in core (`magical_merchant_core::sync::engine`); what stays here is
//! only the commands, the in-progress state, the events, and building the HTTP client.

use std::future::Future;
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

/// How a round that ran ended, on its way to the webview as one of the two events
#[derive(Debug)]
enum RoundEnd<'a> {
    Complete(&'a SyncResult),
    Error(&'a SyncError),
}

#[tauri::command]
pub(crate) async fn sync_start(
    handle: AppHandle,
    state: State<'_, AppSyncState>,
) -> Result<SyncResult, SyncError> {
    // `do_sync` is an async fn, so building its future here runs nothing: a start the guard
    // refuses never reads the config or touches the network
    run_round(state.inner(), do_sync(&handle), |end| {
        // A webview that is gone has nobody left to tell
        let _ = match end {
            RoundEnd::Complete(result) => handle.emit(EVENT_SYNC_COMPLETE, result),
            RoundEnd::Error(err) => handle.emit(EVENT_SYNC_ERROR, err),
        };
    })
    .await
}

/// `sync_start` with the round and the events passed in, so it runs in a test with neither a
/// server nor a webview
async fn run_round<R, E>(state: &AppSyncState, round: R, emit: E) -> Result<SyncResult, SyncError>
where
    R: Future<Output = Result<SyncResult, SyncError>>,
    E: Fn(RoundEnd<'_>),
{
    if state
        .is_syncing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(SyncError::new("busy", "Sync already in progress"));
    }
    let _guard = SyncingGuard(&state.is_syncing);

    let result = round.await;

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
            emit(RoundEnd::Complete(sync_result));
        }
        Err(err) => {
            *state
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(err.message.clone());
            emit(RoundEnd::Error(err));
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
    // Past half its lifetime the login is traded for a fresh one, so a device that syncs
    // never signs out. The CLI does the same at its entry
    let client = match token::renew_if_due(&token, &client, |fresh| {
        token::store_token(&base_dir, fresh)
    })
    .await?
    {
        Some(fresh) => client.with_token(&fresh),
        None => client,
    };

    engine::run(&client, &base_dir).await
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn syncing_guard_clears_flag_on_drop() {
        let flag = AtomicBool::new(true);
        {
            let _guard = SyncingGuard(&flag);
        }
        assert!(!flag.load(Ordering::SeqCst));
    }

    /// The event `sync_start` sends for this end
    const fn event_name(end: &RoundEnd<'_>) -> &'static str {
        match end {
            RoundEnd::Complete(_) => EVENT_SYNC_COMPLETE,
            RoundEnd::Error(_) => EVENT_SYNC_ERROR,
        }
    }

    #[tokio::test]
    async fn a_round_that_succeeds_is_told_as_complete() {
        let state = AppSyncState::default();
        let events = RefCell::new(Vec::new());

        let result = run_round(&state, async { Ok(SyncResult::default()) }, |end| {
            events.borrow_mut().push(event_name(&end));
        })
        .await;

        assert!(result.is_ok());
        assert_eq!(*events.borrow(), [EVENT_SYNC_COMPLETE]);
        assert!(!state.is_syncing.load(Ordering::SeqCst));
    }

    /// The app's own busy guard: no round ran, so there is no event, and the rejection is the
    /// only answer the webview gets
    #[tokio::test]
    async fn a_start_during_a_round_is_refused_without_an_event() {
        let state = AppSyncState::default();
        state.is_syncing.store(true, Ordering::SeqCst);
        let events = RefCell::new(Vec::new());

        let result = run_round(&state, async { Ok(SyncResult::default()) }, |end| {
            events.borrow_mut().push(event_name(&end));
        })
        .await;

        assert_eq!(result.err().map(|e| e.kind), Some("busy"));
        assert!(events.borrow().is_empty());
        // The round in flight still owns the flag
        assert!(state.is_syncing.load(Ordering::SeqCst));
    }
}
