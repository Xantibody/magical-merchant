use std::fs;
use std::path::Path;

use jsonwebtoken::dangerous::insecure_decode;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
#[cfg(target_os = "android")]
use tauri_plugin_opener::OpenerExt;
use url::Url;

const SYNC_CONFIG_FILENAME: &str = "sync-config.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub(crate) struct SyncConfig {
    #[serde(default)]
    pub workers_url: String,
    /// 保存が成功したら自動で同期するか。既存の設定ファイルには無いので default。
    #[serde(default)]
    pub auto_sync: bool,
}

impl SyncConfig {
    pub(crate) fn load(base_dir: &Path) -> Self {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        if !path.exists() {
            return Self::default();
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub(crate) fn save(&self, base_dir: &Path) -> Result<(), String> {
        // 初回起動時は app_data_dir がまだ存在しないことがある
        fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        magical_merchant_core::utils::fs::write_atomic(&path, content)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn is_editable(base_dir: &Path) -> bool {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        if !path.exists() {
            return true;
        }
        !path.metadata().is_ok_and(|m| m.permissions().readonly())
    }

    pub(crate) const fn is_configured(&self) -> bool {
        !self.workers_url.is_empty()
    }
}

/// Workers URL を保存前に正規化・検証する。
/// 末尾スラッシュは API パスが "//files" になり Worker 側で 400 になるため除去する。
fn normalize_workers_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let parsed = Url::parse(trimmed)
        .map_err(|_| "Invalid URL. Expected e.g. https://example.workers.dev".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("URL must start with https:// or http://".to_string());
    }
    Ok(trimmed.to_string())
}

// ──────────── Token storage ────────────
//
// keyring クレートは Android にストアを持たず、既定でプロセス内 mock に落ちる。
// mock は Entry ごとに空の入れ物を作るので、保存したトークンは二度と読めない
// （ログイン直後から「未ログイン」のまま）。Android だけアプリ専用ディレクトリの
// ファイルに置く。OS がアプリ間のアクセスを遮断しているので、他アプリからは読めない。

#[cfg(target_os = "android")]
mod token_store {
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};

    const TOKEN_FILENAME: &str = "auth-token";

    fn path(base_dir: &Path) -> PathBuf {
        base_dir.join(TOKEN_FILENAME)
    }

    pub(super) fn store(base_dir: &Path, token: &str) -> Result<(), String> {
        fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
        let path = path(base_dir);
        magical_merchant_core::utils::fs::write_atomic(&path, token).map_err(|e| e.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())
    }

    pub(super) fn get(base_dir: &Path) -> Result<Option<String>, String> {
        match fs::read_to_string(path(base_dir)) {
            Ok(token) => Ok(Some(token.trim().to_string()).filter(|t| !t.is_empty())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(super) fn clear(base_dir: &Path) -> Result<(), String> {
        match fs::remove_file(path(base_dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "android"))]
mod token_store {
    use std::path::Path;

    const KEYCHAIN_SERVICE: &str = "com.magical-merchant.app";
    const KEYCHAIN_ACCOUNT: &str = "auth-jwt";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
    }

    pub(super) fn store(_base_dir: &Path, token: &str) -> Result<(), String> {
        entry()?.set_password(token).map_err(|e| e.to_string())
    }

    pub(super) fn get(_base_dir: &Path) -> Result<Option<String>, String> {
        match entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub(super) fn clear(_base_dir: &Path) -> Result<(), String> {
        match entry()?.delete_credential() {
            // Deleting a credential that was never stored leaves the desired state.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub(crate) fn store_token(base_dir: &Path, token: &str) -> Result<(), String> {
    token_store::store(base_dir, token)
}

pub(crate) fn get_token(base_dir: &Path) -> Result<Option<String>, String> {
    token_store::get(base_dir)
}

pub(crate) fn clear_token(base_dir: &Path) -> Result<(), String> {
    token_store::clear(base_dir)
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    exp: i64,
}

/// 署名は検証しない。鍵は Worker 側にしか無く、ここで見たいのは
/// 「まだ使える token か」だけ — 実際の可否は Worker が握っている。
pub(crate) fn is_token_valid(token: &str) -> bool {
    let Ok(token_data) = insecure_decode::<Claims>(token) else {
        return false;
    };

    let now = chrono::Utc::now().timestamp();
    // 5 minute buffer
    token_data.claims.exp > now + 300
}

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
    let config = SyncConfig::load(&base_dir);

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

#[tauri::command]
pub(crate) fn get_sync_config(handle: AppHandle) -> Result<SyncConfig, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(SyncConfig::load(&base_dir))
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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// 署名は誰も見ないので、鍵も crypto backend も要らない。
    /// jsonwebtoken の `encode` を呼ぶとテストのためだけに署名実装を
    /// 抱き込むことになるため、3 つのパートを直に組む。
    fn make_jwt(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Claims { exp }).unwrap());
        format!("{header}.{claims}.not-a-real-signature")
    }

    #[test]
    fn valid_token_not_expired() {
        let future = chrono::Utc::now().timestamp() + 3600;
        assert!(is_token_valid(&make_jwt(future)));
    }

    #[test]
    fn expired_token() {
        let past = chrono::Utc::now().timestamp() - 100;
        assert!(!is_token_valid(&make_jwt(past)));
    }

    #[test]
    fn token_expiring_within_buffer() {
        let soon = chrono::Utc::now().timestamp() + 60; // Within 5min buffer
        assert!(!is_token_valid(&make_jwt(soon)));
    }

    #[test]
    fn invalid_token_format() {
        assert!(!is_token_valid("not-a-jwt"));
        assert!(!is_token_valid("a.b"));
        assert!(!is_token_valid(""));
    }

    #[test]
    fn sync_config_not_configured_when_empty() {
        let config = SyncConfig::default();
        assert!(!config.is_configured());
    }

    #[test]
    fn sync_config_is_configured() {
        let config = SyncConfig {
            workers_url: "https://sync.example.com".to_string(),
            ..SyncConfig::default()
        };
        assert!(config.is_configured());
    }

    #[test]
    fn sync_config_save_creates_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        // 初回起動時は app_data_dir 自体がまだ存在しない
        let base = dir.path().join("not-yet-created");
        let config = SyncConfig {
            workers_url: "https://sync.example.com".to_string(),
            ..SyncConfig::default()
        };
        config.save(&base).unwrap();
        let loaded = SyncConfig::load(&base);
        assert_eq!(loaded.workers_url, "https://sync.example.com");
    }

    #[test]
    fn sync_config_round_trips_auto_sync() {
        let dir = tempfile::tempdir().unwrap();
        let config = SyncConfig {
            workers_url: "https://sync.example.com".to_string(),
            auto_sync: true,
        };
        config.save(dir.path()).unwrap();
        assert!(SyncConfig::load(dir.path()).auto_sync);
    }

    #[test]
    fn sync_config_defaults_auto_sync_off_for_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SYNC_CONFIG_FILENAME),
            r#"{"workers_url":"https://sync.example.com"}"#,
        )
        .unwrap();
        assert!(!SyncConfig::load(dir.path()).auto_sync);
    }

    #[test]
    fn normalize_workers_url_trims_trailing_slash_and_whitespace() {
        assert_eq!(
            normalize_workers_url(" https://sync.example.com/ ").unwrap(),
            "https://sync.example.com"
        );
    }

    #[test]
    fn normalize_workers_url_allows_empty_for_unconfigured() {
        assert_eq!(normalize_workers_url("").unwrap(), "");
        assert_eq!(normalize_workers_url("   ").unwrap(), "");
    }

    #[test]
    fn normalize_workers_url_rejects_invalid_scheme() {
        assert!(normalize_workers_url("ftp://example.com").is_err());
        assert!(normalize_workers_url("not a url").is_err());
        assert!(normalize_workers_url("example.workers.dev").is_err());
    }

    #[test]
    fn sync_config_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let config = SyncConfig {
            workers_url: "https://sync.example.com".to_string(),
            ..SyncConfig::default()
        };
        config.save(dir.path()).unwrap();
        let loaded = SyncConfig::load(dir.path());
        assert_eq!(loaded.workers_url, "https://sync.example.com");
    }

    #[test]
    fn sync_config_load_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(SyncConfig::load(dir.path()), SyncConfig::default());
    }

    #[test]
    fn sync_config_editable_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(SyncConfig::is_editable(dir.path()));
    }

    #[test]
    fn sync_config_editable_when_writable() {
        let dir = tempfile::tempdir().unwrap();
        let config = SyncConfig::default();
        config.save(dir.path()).unwrap();
        assert!(SyncConfig::is_editable(dir.path()));
    }

    #[test]
    fn sync_config_not_editable_when_readonly() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SYNC_CONFIG_FILENAME);
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(!SyncConfig::is_editable(dir.path()));
    }
}
