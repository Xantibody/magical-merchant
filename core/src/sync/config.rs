//! `sync-config.json` — アプリと CLI が共通で読む同期設定。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use url::Url;

use super::SyncError;

const SYNC_CONFIG_FILENAME: &str = "sync-config.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SyncConfig {
    #[serde(default)]
    pub workers_url: String,
    /// 保存が成功したら自動で同期するか。既存の設定ファイルには無いので default。
    #[serde(default)]
    pub auto_sync: bool,
}

impl SyncConfig {
    /// 設定が無ければ `None`。読めなかった場合は `None` に丸めない —
    /// 「未設定」として扱うと設定画面が空欄で開き、ユーザーが URL を
    /// 入れ直した瞬間に、壊れているだけの設定が上書きされる。
    pub fn load(base_dir: &Path) -> Result<Option<Self>, SyncError> {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        if !path.exists() {
            return Ok(None);
        }
        let corrupt = |e: &dyn std::error::Error| {
            SyncError::new(
                "configCorrupt",
                format!("Could not read {SYNC_CONFIG_FILENAME}: {e}"),
            )
        };
        let content = fs::read_to_string(&path).map_err(|e| corrupt(&e))?;
        serde_json::from_str(&content)
            .map(Some)
            .map_err(|e| corrupt(&e))
    }

    pub fn save(&self, base_dir: &Path) -> Result<(), String> {
        // 初回起動時は app_data_dir がまだ存在しないことがある
        fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::utils::fs::write_atomic(&path, content).map_err(|e| e.to_string())?;
        Ok(())
    }

    #[must_use]
    pub fn is_editable(base_dir: &Path) -> bool {
        let path = base_dir.join(SYNC_CONFIG_FILENAME);
        if !path.exists() {
            return true;
        }
        !path.metadata().is_ok_and(|m| m.permissions().readonly())
    }

    #[must_use]
    pub const fn is_configured(&self) -> bool {
        !self.workers_url.is_empty()
    }
}

/// Workers URL を保存前に正規化・検証する。
/// 末尾スラッシュは API パスが "//files" になり Worker 側で 400 になるため除去する。
pub fn normalize_workers_url(input: &str) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let loaded = SyncConfig::load(&base).unwrap().unwrap();
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
        assert!(SyncConfig::load(dir.path()).unwrap().unwrap().auto_sync);
    }

    #[test]
    fn sync_config_defaults_auto_sync_off_for_existing_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(SYNC_CONFIG_FILENAME),
            r#"{"workers_url":"https://sync.example.com"}"#,
        )
        .unwrap();
        assert!(!SyncConfig::load(dir.path()).unwrap().unwrap().auto_sync);
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
        let loaded = SyncConfig::load(dir.path()).unwrap().unwrap();
        assert_eq!(loaded.workers_url, "https://sync.example.com");
    }

    #[test]
    fn sync_config_load_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(SyncConfig::load(dir.path()).unwrap(), None);
    }

    /// 壊れた設定を「未設定」として返すと、設定画面が空欄で開く。そこに
    /// URL を入れ直した時点で、読めなかっただけの設定が上書きされる
    #[test]
    fn sync_config_load_refuses_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(SYNC_CONFIG_FILENAME), "{ not json").unwrap();

        let err = SyncConfig::load(dir.path()).unwrap_err();

        assert_eq!(err.kind, "configCorrupt");
        assert!(err.message.contains(SYNC_CONFIG_FILENAME));
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
