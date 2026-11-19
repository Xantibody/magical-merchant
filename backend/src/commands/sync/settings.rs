//! The sync settings screen's commands. The config file lives in core
//! (`magical_merchant_core::domain::sync::settings`).

use magical_merchant_core::domain::sync::settings::{SyncConfig, normalize_workers_url};
use tauri::{AppHandle, Runtime};

use crate::commands::error::CommandError;
use crate::services::tauri::app_base_dir;

/// A config that could not be read comes back as `kind: "configCorrupt"`.
///
/// Substituting the default would open the settings screen blank, and the re-entered
/// URL would then overwrite the broken file
#[tauri::command]
pub(crate) fn get_sync_config<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<SyncConfig, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    Ok(SyncConfig::load(&base_dir)?.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn save_sync_config<R: Runtime>(
    handle: AppHandle<R>,
    config: SyncConfig,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let config = SyncConfig {
        workers_url: normalize_workers_url(&config.workers_url)?,
        ..config
    };
    config.save(&base_dir)
}

#[tauri::command]
pub(crate) fn is_sync_config_editable<R: Runtime>(handle: AppHandle<R>) -> Result<bool, String> {
    let base_dir = app_base_dir(&handle)?;
    Ok(SyncConfig::is_editable(&base_dir))
}

/// What the sync settings commands answer, called through a mock app over a temporary
/// data directory.
#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "a test app holds the data directory until the test ends"
)]
mod tests {
    use super::*;
    use crate::test_app::test_app;

    fn with_url(workers_url: &str) -> SyncConfig {
        SyncConfig {
            workers_url: workers_url.to_string(),
            ..SyncConfig::default()
        }
    }

    #[test]
    fn save_sync_config_drops_the_trailing_slash_and_the_spaces_around() {
        let app = test_app();

        save_sync_config(app.handle(), with_url("  https://example.workers.dev/  ")).unwrap();

        let saved = get_sync_config(app.handle()).unwrap();
        assert_eq!(saved.workers_url, "https://example.workers.dev");
    }

    #[test]
    fn save_sync_config_refuses_a_url_that_is_not_http_in_words() {
        let app = test_app();

        let refused = save_sync_config(app.handle(), with_url("ftp://example.com"));

        assert_eq!(
            refused,
            Err("URL must start with https:// or http://".to_string())
        );
        assert!(!app.base().join("sync-config.json").exists());
    }

    #[test]
    fn get_sync_config_of_a_broken_file_is_config_corrupt() {
        let app = test_app();
        std::fs::write(app.base().join("sync-config.json"), "{ not json").unwrap();

        let refused = get_sync_config(app.handle()).unwrap_err();

        assert_eq!(refused.kind, "configCorrupt");
    }
}
