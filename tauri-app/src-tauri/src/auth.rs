//! Entry point for signing in. The config file and token storage live in core
//! (`magical_merchant_core::sync::{config, token}`); what stays here is the in-app
//! sign-in window and the Tauri commands called from it.

#[cfg(not(target_os = "android"))]
use std::path::Path;

use magical_merchant_core::sync::SyncError;
use magical_merchant_core::sync::config::{SyncConfig, normalize_workers_url};
#[cfg(not(target_os = "android"))]
use magical_merchant_core::sync::token::store_token;
use magical_merchant_core::sync::token::{clear_token, get_token, is_token_valid};
use tauri::AppHandle;
// Only the desktop build looks up or creates a sign-in window. Android hands the URL
// to the default browser, so nothing there uses this trait
#[cfg(not(target_os = "android"))]
use tauri::Manager;
#[cfg(target_os = "android")]
use tauri_plugin_opener::OpenerExt;
#[cfg(not(target_os = "android"))]
use url::Url;

fn build_auth_url(workers_url: &str, app_redirect: &str) -> String {
    format!(
        "{}/auth/google?app_redirect={}",
        workers_url.trim_end_matches('/'),
        urlencoding::encode(app_redirect)
    )
}

/// The in-app window that shows the sign-in page.
///
/// It keeps a single label, and from the second time on the same window is sent to the
/// next URL: `close()` goes through the event loop, so rebuilding with the same label
/// right after closing can collide.
#[cfg(not(target_os = "android"))]
const AUTH_WINDOW_LABEL: &str = "auth";

/// Keeps sign-in inside the app.
///
/// Handing it to an external browser puts the app behind, and after approval the user
/// has to come back on their own. Authentication ends where it started.
#[cfg(not(target_os = "android"))]
fn open_auth_window(handle: &AppHandle, auth_url: &str) -> Result<tauri::WebviewWindow, String> {
    let url = Url::parse(auth_url).map_err(|e| format!("Invalid auth URL: {e}"))?;

    if let Some(existing) = handle.get_webview_window(AUTH_WINDOW_LABEL) {
        existing
            .navigate(url)
            .map_err(|e| format!("Failed to open the sign-in window: {e}"))?;
        let _ = existing.set_focus();
        return Ok(existing);
    }

    tauri::WebviewWindowBuilder::new(handle, AUTH_WINDOW_LABEL, tauri::WebviewUrl::External(url))
        .title("Sign in")
        .inner_size(520.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to open the sign-in window: {e}"))
}

/// A one-shot receiver that reports the window being closed.
///
/// Waiting on after it is closed would hold a user who meant to stop until the
/// 5-minute timeout.
#[cfg(not(target_os = "android"))]
fn closed_signal(window: &tauri::WebviewWindow) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // `on_window_event` wants an `Fn`, so the one-shot sender is wrapped and taken out
    let tx = std::sync::Mutex::new(Some(tx));
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(());
        }
    });
    rx
}

/// The only page returned to the browser. The app closes the window right after, so it
/// carries nothing but a note.
#[cfg(not(target_os = "android"))]
const CALLBACK_RESPONSE: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/html; charset=utf-8\r\n",
    "Connection: close\r\n\r\n",
    "<html><body><p>You can close this window.</p></body></html>"
);

/// The reply to a request that arrives while waiting and is not the callback.
#[cfg(not(target_os = "android"))]
const NOT_FOUND_RESPONSE: &str = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";

/// Reads out of a raw HTTP request only a token that may be stored.
///
/// The loopback socket is open for the whole of sign-in, and any local process can hit
/// it. The nonce in the path is the only proof that this is the return of the sign-in
/// started from this window, and the JWT expiry is the minimum check that its contents
/// are usable.
#[cfg(not(target_os = "android"))]
fn callback_token(request_text: &str, callback_path: &str) -> Option<String> {
    let target = request_text.lines().next()?.split_whitespace().nth(1)?;
    // AIDEV-NOTE: drop request targets in absolute URL form. `join` replaces the host too, so the path alone could be made to match
    if !target.starts_with('/') {
        return None;
    }
    let url = Url::parse("http://127.0.0.1/").ok()?.join(target).ok()?;
    if url.path() != callback_path {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|token| is_token_valid(token))
}

/// How long one connection may be held.
///
/// A browser sends its request right after it connects, so this is enough for the real
/// one. Reads run in parallel, so raising this limit does not delay accepting the
/// callback; it only moves when a silent connection is dropped.
#[cfg(not(target_os = "android"))]
const CONNECTION_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Reads one accepted connection and returns only a token that may be stored. A reply
/// is written either way: the note for the real one, 404 for everything else.
#[cfg(not(target_os = "android"))]
async fn read_callback_token(
    mut stream: tokio::net::TcpStream,
    callback_path: &str,
    read_timeout: std::time::Duration,
) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = vec![0u8; 4096];
    // Do not hold on to a connection that stays open and sends nothing. A timeout and
    // a failed read are both reasons to drop this one
    let Ok(Ok(n)) = tokio::time::timeout(read_timeout, stream.read(&mut buf)).await else {
        return None;
    };
    let token = callback_token(&String::from_utf8_lossy(&buf[..n]), callback_path);

    let response = if token.is_some() {
        CALLBACK_RESPONSE
    } else {
        NOT_FOUND_RESPONSE
    };
    let _ = stream.write_all(response.as_bytes()).await;

    token
}

/// Waits until a callback with a matching nonce arrives.
///
/// Anything that does not match is dropped with a 404 and the wait goes on, so merely
/// connecting first does not let someone take over the sign-in.
///
/// Reads run in parallel and accepting never stops. The port can be found by brute
/// force, so a local process can open as many connections as it likes.
///
/// AIDEV-NOTE: connections are read in parallel. Reading them in order was rejected: 60 silent connections alone could eat the whole 300-second window
#[cfg(not(target_os = "android"))]
async fn accept_callback_token(
    listener: &tokio::net::TcpListener,
    callback_path: &str,
    read_timeout: std::time::Duration,
) -> Result<String, String> {
    let mut reading = tokio::task::JoinSet::new();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted
                    .map_err(|e| format!("Failed to accept connection: {e}"))?;
                let callback_path = callback_path.to_owned();
                reading.spawn(async move {
                    read_callback_token(stream, &callback_path, read_timeout).await
                });
            }
            // A connection that turned out invalid is only a reason to wait for the
            // next. An empty `JoinSet` returns `None` at once, so that round drops this
            // arm and waits on `accept` alone
            Some(read) = reading.join_next() => {
                if let Ok(Some(token)) = read {
                    return Ok(token);
                }
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
async fn login_with_loopback(
    handle: &AppHandle,
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

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    const CALLBACK_PATH: &str = "/callback/11111111-2222-3333-4444-555555555555";

    /// Nobody looks at the signature (same reason as `sync::token::is_token_valid`), so
    /// the three parts are built directly
    fn jwt(expires_in: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let exp = chrono::Utc::now().timestamp() + expires_in;
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    }

    #[test]
    fn the_token_on_the_callback_path_is_taken() {
        let token = jwt(3600);
        let request = get(&format!("{CALLBACK_PATH}?token={token}"));

        assert_eq!(callback_token(&request, CALLBACK_PATH), Some(token));
    }

    /// A caller that does not know the nonce gets nothing even if it connects first.
    /// Getting this wrong points every later sync at their account
    #[test]
    fn a_token_on_another_path_is_ignored() {
        let request = get(&format!("/callback?token={}", jwt(3600)));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    /// Storing an expired token destroys a live one and then stops the next sync with
    /// "please sign in again"
    #[test]
    fn an_expired_token_is_ignored() {
        let request = get(&format!("{CALLBACK_PATH}?token={}", jwt(-100)));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_malformed_token_is_ignored() {
        let request = get(&format!("{CALLBACK_PATH}?token=not-a-jwt"));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_request_without_a_token_is_ignored() {
        assert_eq!(callback_token(&get(CALLBACK_PATH), CALLBACK_PATH), None);
    }

    /// A request line in absolute URL form could be made to match on the path alone
    #[test]
    fn an_absolute_request_target_is_ignored() {
        let request = get(&format!(
            "http://evil.example{CALLBACK_PATH}?token={}",
            jwt(3600)
        ));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_request_that_is_not_http_is_ignored() {
        assert_eq!(callback_token("", CALLBACK_PATH), None);
        assert_eq!(callback_token("garbage", CALLBACK_PATH), None);
    }

    /// The port can be found by brute force.
    ///
    /// If one local process that connects and sends nothing were enough to block
    /// sign-in, the nonce would still hold but the user would wait out the outer
    /// 5 minutes
    #[tokio::test]
    async fn a_silent_connection_does_not_hold_up_the_callback() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // accept order is connection order, so the silent one comes out first
        let _silent = tokio::net::TcpStream::connect(addr).await.unwrap();

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            accept_callback_token(
                &listener,
                CALLBACK_PATH,
                std::time::Duration::from_millis(50),
            ),
        )
        .await
        .expect("the silent connection must not keep the callback waiting");

        assert_eq!(accepted, Ok(token));
    }

    /// Lining up silent connections has the same effect as letting one sit forever.
    ///
    /// Read one at a time, they delay accepting the callback by the read timeout times
    /// the number lined up, which can eat the whole outer 5 minutes
    #[tokio::test]
    async fn many_silent_connections_do_not_hold_up_the_callback() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // 60 connections at 5 seconds each is 300 seconds: the real read timeout, as
        // long as the outer window
        let mut silent = Vec::new();
        for _ in 0..60 {
            silent.push(tokio::net::TcpStream::connect(addr).await.unwrap());
        }

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            accept_callback_token(&listener, CALLBACK_PATH, CONNECTION_READ_TIMEOUT),
        )
        .await
        .expect("queued silent connections must not delay the callback");

        assert_eq!(accepted, Ok(token));
        // Lining them up means nothing unless they stay connected for the whole wait
        drop(silent);
    }

    /// Even when several with the wrong nonce are read first, the waiting side takes
    /// only the one that matches.
    ///
    /// Reading in parallel returns "invalid" more than once, so this pins down that
    /// none of those ends the wait
    #[tokio::test]
    async fn the_valid_token_wins_over_connections_read_alongside_it() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let stolen = jwt(3600);
        let mut impostors = Vec::new();
        for _ in 0..10 {
            let mut impostor = tokio::net::TcpStream::connect(addr).await.unwrap();
            impostor
                .write_all(get(&format!("/callback/other?token={stolen}")).as_bytes())
                .await
                .unwrap();
            impostors.push(impostor);
        }

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            accept_callback_token(&listener, CALLBACK_PATH, CONNECTION_READ_TIMEOUT),
        )
        .await
        .expect("a mismatched nonce must not end the wait");

        assert_eq!(accepted, Ok(token));
        drop(impostors);
    }
}

// Tauri commands

#[tauri::command]
pub(crate) async fn auth_login(handle: AppHandle) -> Result<(), String> {
    let base_dir = crate::app_base_dir(&handle)?;
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
    let base_dir = crate::app_base_dir(&handle)?;
    Ok(get_token(&base_dir)?.is_some_and(|token| is_token_valid(&token)))
}

#[tauri::command]
pub(crate) fn auth_logout(handle: AppHandle) -> Result<(), String> {
    let base_dir = crate::app_base_dir(&handle)?;
    clear_token(&base_dir)
}

/// A config that could not be read comes back as `kind: "configCorrupt"`.
///
/// Substituting the default would open the settings screen blank, and the re-entered
/// URL would then overwrite the broken file
#[tauri::command]
pub(crate) fn get_sync_config(handle: AppHandle) -> Result<SyncConfig, SyncError> {
    let base_dir = crate::app_base_dir(&handle).map_err(SyncError::other)?;
    Ok(SyncConfig::load(&base_dir)?.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn save_sync_config(handle: AppHandle, config: SyncConfig) -> Result<(), String> {
    let base_dir = crate::app_base_dir(&handle)?;
    let config = SyncConfig {
        workers_url: normalize_workers_url(&config.workers_url)?,
        auto_sync: config.auto_sync,
    };
    config.save(&base_dir)
}

#[tauri::command]
pub(crate) fn is_sync_config_editable(handle: AppHandle) -> Result<bool, String> {
    let base_dir = crate::app_base_dir(&handle)?;
    Ok(SyncConfig::is_editable(&base_dir))
}
