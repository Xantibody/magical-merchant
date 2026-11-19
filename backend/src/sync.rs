//! The Tauri side of sync.
//!
//! The engine itself is in core (`magical_merchant_core::domain::sync::run`); what stays here is
//! only the commands, the in-progress state, the events, and building the HTTP client.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use magical_merchant_core::SyncError;
use magical_merchant_core::domain::sync::{SyncResult, login, run};
use magical_merchant_core::utils::clock::UtcStamp;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};

const EVENT_SYNC_COMPLETE: &str = "sync-complete";
const EVENT_SYNC_ERROR: &str = "sync-error";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SyncStatusInfo {
    pub is_syncing: bool,
    pub last_synced_at: Option<UtcStamp>,
    pub last_error: Option<String>,
}

pub(crate) struct AppSyncState {
    pub is_syncing: AtomicBool,
    pub last_synced_at: Mutex<Option<UtcStamp>>,
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
use magical_merchant_core::services::worker::desktop_http_client as http_client;

/// Only Android bypasses the device's verifier. The reason is in `android_tls::sync_tls_config`
#[cfg(target_os = "android")]
fn http_client() -> Result<reqwest::Client, SyncError> {
    use magical_merchant_core::describe;

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

/// Starts a round. However it ends, the webview hears it once, as `sync-complete` or
/// `sync-error`, and the command resolves. It rejects only when no round ran because one was
/// already running, and that sends no event.
///
/// AIDEV-NOTE: a failed round used to be emitted and rejected both, and the webview applied it twice. Dropping the duplicate on the webview's side was rejected: there this guard's rejected `busy` and the engine lock's emitted `busy` look the same
#[tauri::command]
pub(crate) async fn sync_start(
    handle: AppHandle,
    state: State<'_, AppSyncState>,
) -> Result<(), SyncError> {
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
async fn run_round<R, E>(state: &AppSyncState, round: R, emit: E) -> Result<(), SyncError>
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

    match round.await {
        Ok(sync_result) => {
            // Cleaning up duplicate IDs that came down happens inside the engine. Doing it
            // after the lock is released would move notes in the middle of the scan a
            // waiting CLI has started
            *state
                .last_synced_at
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(UtcStamp::now());
            *state
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = None;
            emit(RoundEnd::Complete(&sync_result));
        }
        Err(err) => {
            *state
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(err.message.clone());
            emit(RoundEnd::Error(&err));
        }
    }

    Ok(())
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

/// Has core check the login and build the client, then hands it to core's engine.
/// `AppHandle` is used only to resolve the base dir; the TLS branch is `http_client`'s.
async fn do_sync<R: Runtime>(handle: &AppHandle<R>) -> Result<SyncResult, SyncError> {
    let base_dir = crate::app_base_dir(handle).map_err(SyncError::other)?;
    // The repair before the scan is done by the engine inside the lock. That also covers
    // pressing sync after looking only at Scrawl, which never went through the listing's
    // `repair_once`
    let client = login::sync_client(
        &base_dir,
        http_client,
        "Settings",
        || login::get_token(&base_dir),
        |fresh| login::store_token(&base_dir, fresh),
    )
    .await?;

    run::run(&client, &base_dir).await
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

    /// The webview reads `last_synced_at` as chrono's serde writes it: `Z`, and a fraction
    /// of exactly 3, 6 or 9 digits or none at all.
    #[test]
    fn last_synced_at_crosses_ipc_as_z_with_whole_digit_groups() {
        for (at, expected) in [
            (
                Some("2026-08-05T00:00:00Z"),
                r#"{"is_syncing":false,"last_synced_at":"2026-08-05T00:00:00Z","last_error":null}"#,
            ),
            (
                Some("2026-08-05T00:00:00.120Z"),
                r#"{"is_syncing":false,"last_synced_at":"2026-08-05T00:00:00.120Z","last_error":null}"#,
            ),
            (
                Some("2026-08-05T00:00:00.1Z"),
                r#"{"is_syncing":false,"last_synced_at":"2026-08-05T00:00:00.100Z","last_error":null}"#,
            ),
            (
                Some("2026-08-05T00:00:00.123400Z"),
                r#"{"is_syncing":false,"last_synced_at":"2026-08-05T00:00:00.123400Z","last_error":null}"#,
            ),
            (
                Some("2026-08-05T00:00:00.544569369Z"),
                r#"{"is_syncing":false,"last_synced_at":"2026-08-05T00:00:00.544569369Z","last_error":null}"#,
            ),
            (
                Some("2026-08-05T09:00:00.120+09:00"),
                r#"{"is_syncing":false,"last_synced_at":"2026-08-05T00:00:00.120Z","last_error":null}"#,
            ),
            (
                None,
                r#"{"is_syncing":false,"last_synced_at":null,"last_error":null}"#,
            ),
        ] {
            let info = SyncStatusInfo {
                is_syncing: false,
                last_synced_at: at.map(|text| text.parse::<UtcStamp>().unwrap()),
                last_error: None,
            };

            let json = serde_json::to_string(&info).unwrap();

            assert_eq!(json, expected, "{at:?}");
        }
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

    /// The webview applies whatever it hears. Told by the event and again by the rejection, it
    /// raised the alert twice, and a rejection landing after the rerun had started marked that
    /// rerun as failed
    #[tokio::test]
    async fn a_round_that_fails_is_told_once_through_the_event() {
        let state = AppSyncState::default();
        let events = RefCell::new(Vec::new());

        let result = run_round(
            &state,
            async { Err(SyncError::new("notAuthenticated", "Not logged in.")) },
            |end| events.borrow_mut().push(event_name(&end)),
        )
        .await;

        assert!(result.is_ok());
        assert_eq!(*events.borrow(), [EVENT_SYNC_ERROR]);
        assert_eq!(
            state
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_deref(),
            Some("Not logged in.")
        );
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

    /// Without a Workers URL the round stops before the token is read, so a device never set
    /// up does not open the OS keychain
    #[test]
    #[allow(
        clippy::significant_drop_tightening,
        reason = "a test app holds the data directory until the test ends"
    )]
    fn a_sync_with_no_workers_url_is_not_configured() {
        let app = crate::test_app::test_app();

        let refused = tauri::async_runtime::block_on(do_sync(&app.handle())).unwrap_err();

        assert_eq!(refused.kind, "notConfigured");
        assert_eq!(
            refused.message,
            "Sync is not set up. Add your Workers URL in Settings."
        );
    }
}
