use std::fs;
use std::path::Path;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const KEYCHAIN_SERVICE: &str = "com.magical-merchant.app";
const KEYCHAIN_ACCOUNT: &str = "auth-jwt";
const SYNC_CONFIG_FILENAME: &str = "sync-config.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SyncConfig {
    #[serde(default)]
    pub workers_url: String,
}

impl SyncConfig {
    pub fn load(base_dir: &Path) -> Self {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        if !path.exists() {
            return Self::default();
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, base_dir: &Path) -> Result<(), String> {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_editable(base_dir: &Path) -> bool {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        if !path.exists() {
            return true;
        }
        !path.metadata().is_ok_and(|m| m.permissions().readonly())
    }

    pub fn is_configured(&self) -> bool {
        !self.workers_url.is_empty()
    }
}

pub fn store_token(token: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn get_token() -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn clear_token() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    exp: i64,
}

pub fn is_token_valid(token: &str) -> bool {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.insecure_disable_signature_validation();
    validation.validate_exp = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();

    let token_data = match decode::<Claims>(token, &DecodingKey::from_secret(&[]), &validation) {
        Ok(data) => data,
        Err(_) => return false,
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

#[cfg(not(target_os = "android"))]
async fn login_with_loopback(handle: &AppHandle, config: &SyncConfig) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let app_redirect = format!("http://127.0.0.1:{port}/callback");
    let auth_url = build_auth_url(&config.workers_url, &app_redirect);

    handle
        .opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;

    let (mut stream, _) = listener
        .accept()
        .await
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

    let response_body = if let Ok(url) = Url::parse(&full_url) {
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .map(|(_, v)| v.to_string());

        if let Some(token) = token {
            store_token(&token)?;
            "<html><body><p>Login successful. You can close this tab.</p></body></html>"
        } else {
            "<html><body><p>Login failed: no token received.</p></body></html>"
        }
    } else {
        "<html><body><p>Login failed: invalid callback.</p></body></html>"
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{response_body}"
    );
    let _ = stream.write_all(response.as_bytes()).await;

    Ok(())
}

// Tauri commands

#[tauri::command]
pub async fn auth_login(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = SyncConfig::load(&base_dir);

    if !config.is_configured() {
        return Err("Sync not configured".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        login_with_loopback(&handle, &config).await
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
pub fn auth_status() -> Result<bool, String> {
    match get_token()? {
        Some(token) => Ok(is_token_valid(&token)),
        None => Ok(false),
    }
}

#[tauri::command]
pub fn auth_logout() -> Result<(), String> {
    clear_token()
}

#[tauri::command]
pub fn get_sync_config(handle: AppHandle) -> Result<SyncConfig, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(SyncConfig::load(&base_dir))
}

#[tauri::command]
pub fn save_sync_config(handle: AppHandle, config: SyncConfig) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    config.save(&base_dir)
}

#[tauri::command]
pub fn is_sync_config_editable(handle: AppHandle) -> Result<bool, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(SyncConfig::is_editable(&base_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};

    fn make_jwt(exp: i64) -> String {
        let claims = Claims { exp };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(b"test-secret"),
        )
        .unwrap()
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
        };
        assert!(config.is_configured());
    }

    #[test]
    fn sync_config_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let config = SyncConfig {
            workers_url: "https://sync.example.com".to_string(),
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
