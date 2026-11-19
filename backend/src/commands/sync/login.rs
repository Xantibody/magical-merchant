//! Signing in to the sync Worker. The token storage lives in core
//! (`magical_merchant_core::domain::sync::login`), the sign-in window in `services::windows`
//! and the loopback callback in `services::loopback`; what stays here is the commands and the
//! sign-in they start.

#[cfg(not(target_os = "android"))]
use std::path::Path;

#[cfg(not(target_os = "android"))]
use magical_merchant_core::domain::sync::login::store_token;
use magical_merchant_core::domain::sync::login::{clear_token, get_token};
use magical_merchant_core::domain::sync::settings::SyncConfig;
use magical_merchant_core::domain::sync::token::is_token_valid;
use tauri::{AppHandle, Runtime};
#[cfg(target_os = "android")]
use tauri_plugin_opener::OpenerExt;

#[cfg(not(target_os = "android"))]
use crate::services::loopback::{CONNECTION_READ_TIMEOUT, accept_callback_token};
use crate::services::tauri::app_base_dir;
#[cfg(not(target_os = "android"))]
use crate::services::windows::{closed_signal, open_auth_window};

fn build_auth_url(workers_url: &str, app_redirect: &str) -> String {
    format!(
        "{}/auth/google?app_redirect={}",
        workers_url.trim_end_matches('/'),
        urlencoding::encode(app_redirect)
    )
}

#[cfg(not(target_os = "android"))]
async fn login_with_loopback<R: Runtime>(
    handle: &AppHandle<R>,
    base_dir: &Path,
    config: &SyncConfig,
) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // The return target belongs to this one sign-in. The port can be found by brute
    // force, but the nonce cannot be guessed, so only a token that arrives here can be
    // called ours
    let callback_path = format!("/callback/{}", uuid::Uuid::new_v4());
    let app_redirect = format!("http://127.0.0.1:{port}{callback_path}");
    let auth_url = build_auth_url(&config.workers_url, &app_redirect);

    let window = open_auth_window(handle, &auth_url)?;
    let closed = closed_signal(&window);

    let accepted = tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(300), accept_callback_token(&listener, &callback_path, CONNECTION_READ_TIMEOUT)) => result,
        _ = closed => return Err("Login was cancelled.".to_string()),
    };

    let outcome = accepted
        .map_err(|_| "Login timed out. Please try again.".to_string())
        .and_then(|token| token)
        .and_then(|token| store_token(base_dir, &token))
        // Notify so `SyncButton` and the like can reflect the auth state at once
        .inspect(|()| {
            let _ = tauri::Emitter::emit(handle, "auth-success", ());
        });

    // The window is closed whatever the result. The settings screen reports success or
    // failure, so there is no reason to leave the callback page in front of the app
    let _ = window.close();

    outcome
}

#[tauri::command]
pub(crate) async fn auth_login<R: Runtime>(handle: AppHandle<R>) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let config = SyncConfig::load(&base_dir)
        .map_err(|e| e.message)?
        .unwrap_or_default();

    if !config.is_configured() {
        return Err("Sync not configured".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        login_with_loopback(&handle, &base_dir, &config).await
    }

    #[cfg(target_os = "android")]
    {
        let auth_url = build_auth_url(&config.workers_url, "magical-merchant://auth/callback");
        handle
            .opener()
            .open_url(&auth_url, None::<&str>)
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn auth_status(handle: AppHandle) -> Result<bool, String> {
    let base_dir = app_base_dir(&handle)?;
    Ok(get_token(&base_dir)?.is_some_and(|token| is_token_valid(&token)))
}

#[tauri::command]
pub(crate) fn auth_logout(handle: AppHandle) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    clear_token(&base_dir)
}

/// What the login command refuses with, called through a mock app over a temporary data
/// directory.
#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "a test app holds the data directory until the test ends"
)]
mod tests {
    use super::*;
    use crate::commands::sync::settings::get_sync_config;
    use crate::test_app::test_app;

    /// A device never set up is refused before any window or browser opens, in words
    #[test]
    fn auth_login_without_a_workers_url_is_refused_in_words() {
        let app = test_app();

        let refused = tauri::async_runtime::block_on(auth_login(app.handle()));

        assert_eq!(refused, Err("Sync not configured".to_string()));
    }

    /// A broken config is refused with the configCorrupt words alone; the kind is dropped
    #[test]
    fn auth_login_of_a_broken_config_is_refused_with_its_words() {
        let app = test_app();
        std::fs::write(app.base().join("sync-config.json"), "{ not json").unwrap();
        let corrupt = get_sync_config(app.handle()).unwrap_err().message;

        let refused = tauri::async_runtime::block_on(auth_login(app.handle()));

        assert!(corrupt.contains("sync-config.json"), "{corrupt}");
        assert_eq!(refused, Err(corrupt));
    }
}
