use std::fs;
use std::path::Path;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "com.magical-merchant.app";
const KEYCHAIN_ACCOUNT: &str = "cf-access-jwt";
const SYNC_CONFIG_FILENAME: &str = "sync-config.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncConfig {
    #[serde(default)]
    pub workers_url: String,
    #[serde(default)]
    pub team_domain: String,
    #[serde(default)]
    pub app_aud: String,
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

    fn save(&self, base_dir: &Path) -> Result<(), String> {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_configured(&self) -> bool {
        !self.workers_url.is_empty() && !self.team_domain.is_empty() && !self.app_aud.is_empty()
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
    let mut validation = Validation::new(Algorithm::RS256);
    validation.insecure_disable_signature_validation();
    validation.validate_exp = false;
    validation.required_spec_claims.clear();

    let token_data = match decode::<Claims>(token, &DecodingKey::from_secret(&[]), &validation) {
        Ok(data) => data,
        Err(_) => return false,
    };

    let now = chrono::Utc::now().timestamp();
    // 5 minute buffer
    token_data.claims.exp > now + 300
}

pub async fn login_with_browser(config: &SyncConfig) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let auth_url = format!(
        "https://{}.cloudflareaccess.com/cdn-cgi/access/cli?redirect_uri={}&aud={}",
        config.team_domain,
        url::form_urlencoded::byte_serialize(redirect_uri.as_bytes()).collect::<String>(),
        config.app_aud,
    );

    // Open URL in system browser
    open::that(&auth_url).map_err(|e| format!("Failed to open browser: {e}"))?;

    // Wait for callback
    let (stream, _) = listener.accept().await.map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 4096];
    stream.readable().await.map_err(|e| e.to_string())?;
    let n = stream.try_read(&mut buf).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);

    // Extract token from query parameters
    let token = extract_token_from_request(&request)?;

    // Send response to browser
    let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html><body><h1>Authentication successful</h1><p>You can close this tab.</p></body></html>";
    stream.writable().await.map_err(|e| e.to_string())?;
    stream
        .try_write(response.as_bytes())
        .map_err(|e| e.to_string())?;

    Ok(token)
}

fn extract_token_from_request(request: &str) -> Result<String, String> {
    let first_line = request.lines().next().ok_or("Empty request")?;
    let path = first_line
        .split_whitespace()
        .nth(1)
        .ok_or("Invalid HTTP request")?;

    let url = url::Url::parse(&format!("http://localhost{path}")).map_err(|e| e.to_string())?;

    for (key, value) in url.query_pairs() {
        if key == "token" || key == "cf_authorization" {
            return Ok(value.to_string());
        }
    }

    Err("No token found in callback".to_string())
}

// Tauri commands

#[tauri::command]
pub async fn auth_login(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = SyncConfig::load(&base_dir);

    if !config.is_configured() {
        return Err(
            "Sync not configured. Please set Workers URL, team domain, and app AUD in Settings."
                .to_string(),
        );
    }

    let token = login_with_browser(&config).await?;
    store_token(&token)?;
    Ok(())
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
    fn extract_token_from_callback() {
        let request = "GET /callback?token=my-jwt-token HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(extract_token_from_request(request).unwrap(), "my-jwt-token");
    }

    #[test]
    fn extract_cf_authorization_from_callback() {
        let request =
            "GET /callback?cf_authorization=my-cf-token HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert_eq!(extract_token_from_request(request).unwrap(), "my-cf-token");
    }

    #[test]
    fn extract_token_missing() {
        let request = "GET /callback?other=value HTTP/1.1\r\nHost: localhost\r\n\r\n";
        assert!(extract_token_from_request(request).is_err());
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
            team_domain: "myteam".to_string(),
            app_aud: "app-aud-123".to_string(),
        };
        assert!(config.is_configured());
    }

    #[test]
    fn sync_config_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let config = SyncConfig {
            workers_url: "https://sync.example.com".to_string(),
            team_domain: "myteam".to_string(),
            app_aud: "aud123".to_string(),
        };
        config.save(dir.path()).unwrap();
        let loaded = SyncConfig::load(dir.path());
        assert_eq!(loaded.workers_url, "https://sync.example.com");
        assert_eq!(loaded.team_domain, "myteam");
        assert_eq!(loaded.app_aud, "aud123");
    }
}
