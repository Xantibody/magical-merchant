use std::fs;
use std::path::Path;

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const KEYCHAIN_SERVICE: &str = "com.magical-merchant.app";
const KEYCHAIN_ACCOUNT: &str = "cf-access-jwt";
#[cfg(mobile)]
const SYNC_CONFIG_FILENAME: &str = "sync-config.json";
#[cfg(not(mobile))]
const SYNC_CONFIG_PATH: &str = "/etc/magical-merchant/sync-config.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SyncConfig {
    #[serde(default)]
    pub workers_url: String,
}

impl SyncConfig {
    pub fn load(base_dir: &Path) -> Self {
        #[cfg(not(mobile))]
        let _ = base_dir;
        #[cfg(not(mobile))]
        let path = std::path::PathBuf::from(SYNC_CONFIG_PATH);
        #[cfg(mobile)]
        let path = base_dir.join(SYNC_CONFIG_FILENAME);

        if !path.exists() {
            return Self::default();
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    #[cfg(mobile)]
    fn save(&self, base_dir: &Path) -> Result<(), String> {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(())
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
    let mut validation = Validation::new(Algorithm::RS256);
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

pub fn open_login_page(handle: &AppHandle, config: &SyncConfig) -> Result<(), String> {
    let auth_url = format!("{}/auth/login", config.workers_url.trim_end_matches('/'));
    handle
        .opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {e}"))?;
    Ok(())
}

// Tauri commands

#[tauri::command]
pub fn auth_login(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = SyncConfig::load(&base_dir);

    if !config.is_configured() {
        return Err("Sync not configured".to_string());
    }

    open_login_page(&handle, &config)
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
    #[cfg(not(mobile))]
    {
        let _ = (handle, config);
        return Err("Config is read-only on desktop. Use nix-darwin config.".to_string());
    }
    #[cfg(mobile)]
    {
        let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
        config.save(&base_dir)
    }
}

#[tauri::command]
pub fn is_sync_config_editable() -> bool {
    cfg!(mobile)
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
    fn sync_config_load_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let config = SyncConfig::load(dir.path());
        assert_eq!(config, SyncConfig::default());
    }

    #[test]
    fn sync_config_deserialize() {
        let json = r#"{"workers_url":"https://sync.example.com"}"#;
        let config: SyncConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.workers_url, "https://sync.example.com");
    }
}
