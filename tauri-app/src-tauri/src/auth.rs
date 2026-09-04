//! ログインの入口。設定ファイルとトークン保管は core
//! (`magical_merchant_core::sync::{config, token}`) にあり、ここに残るのは
//! アプリ内のログイン窓と、そこから呼ばれる Tauri command だけ。

#[cfg(not(target_os = "android"))]
use std::path::Path;

use magical_merchant_core::sync::SyncError;
use magical_merchant_core::sync::config::{SyncConfig, normalize_workers_url};
#[cfg(not(target_os = "android"))]
use magical_merchant_core::sync::token::store_token;
use magical_merchant_core::sync::token::{clear_token, get_token, is_token_valid};
use tauri::{AppHandle, Manager};
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

/// ログイン画面を出すアプリ内の窓。ラベルは 1 つだけ持ち、二度目からは
/// 同じ窓を次の URL へ送る — `close()` はイベントループ越しなので、閉じた
/// 直後に同じラベルで建て直すと衝突することがある。
#[cfg(not(target_os = "android"))]
const AUTH_WINDOW_LABEL: &str = "auth";

/// ログインをアプリの中で完結させる。外部ブラウザに投げるとアプリが背面へ
/// 回り、承認のあと自分で戻ってこないといけない。認証は始めた場所で終わる。
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

/// 窓が閉じられたことを一度だけ知らせる受け口。閉じたのに待ち続けると、
/// やめたつもりの利用者を 5 分間のタイムアウトまで待たせることになる。
#[cfg(not(target_os = "android"))]
fn closed_signal(window: &tauri::WebviewWindow) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // on_window_event は Fn を求めるので、一度きりの送信側を包んで取り出す
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

#[cfg(not(target_os = "android"))]
async fn login_with_loopback(
    handle: &AppHandle,
    base_dir: &Path,
    config: &SyncConfig,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let app_redirect = format!("http://127.0.0.1:{port}/callback");
    let auth_url = build_auth_url(&config.workers_url, &app_redirect);

    let window = open_auth_window(handle, &auth_url)?;
    let closed = closed_signal(&window);

    let accepted = tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept()) => result,
        _ = closed => return Err("Login was cancelled.".to_string()),
    };
    let (mut stream, _) = accepted
        .map_err(|_| "Login timed out. Please try again.".to_string())?
        .map_err(|e| format!("Failed to accept connection: {e}"))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read: {e}"))?;
    let request_str = String::from_utf8_lossy(&buf[..n]);

    let request_line = request_str.lines().next().unwrap_or("");
    let path = request_line.split_whitespace().nth(1).unwrap_or("");
    let full_url = format!("http://127.0.0.1:{port}{path}");

    let token = Url::parse(&full_url).ok().and_then(|url| {
        url.query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string())
    });

    let outcome = match &token {
        Some(token) => {
            store_token(base_dir, token)?;
            // SyncButton などが認証状態を即時反映できるよう通知する
            let _ = tauri::Emitter::emit(handle, "auth-success", ());
            Ok(())
        }
        None => Err("Login failed: no token received.".to_string()),
    };

    // 窓は結果に関わらず畳む。成否は設定画面が伝えるので、たどり着いた
    // コールバックの画面をアプリの手前に残しておく理由がない
    let body = "<html><body><p>You can close this window.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{body}"
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = window.close();

    outcome
}

// Tauri commands

#[tauri::command]
pub(crate) async fn auth_login(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
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
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(get_token(&base_dir)?.is_some_and(|token| is_token_valid(&token)))
}

#[tauri::command]
pub(crate) fn auth_logout(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    clear_token(&base_dir)
}

/// 読めなかった設定は `kind: "configCorrupt"` で返す。既定値にすり替えると
/// 設定画面が空欄で開き、入力し直した URL が壊れたファイルを上書きする
#[tauri::command]
pub(crate) fn get_sync_config(handle: AppHandle) -> Result<SyncConfig, SyncError> {
    let base_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| SyncError::other(e.to_string()))?;
    Ok(SyncConfig::load(&base_dir)?.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn save_sync_config(handle: AppHandle, config: SyncConfig) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = SyncConfig {
        workers_url: normalize_workers_url(&config.workers_url)?,
        auto_sync: config.auto_sync,
    };
    config.save(&base_dir)
}

#[tauri::command]
pub(crate) fn is_sync_config_editable(handle: AppHandle) -> Result<bool, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(SyncConfig::is_editable(&base_dir))
}
