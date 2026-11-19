//! The tags in use, for the tag editor's suggestions.

use magical_merchant_core::TagUsage;
use tauri::{AppHandle, Runtime};

use crate::services::tauri::{app_base_dir, off_main_thread};

/// How many records carry each tag, most used first, for the tag editor's suggestions. The
/// scan is `browse_all`'s; what crosses to the screen is one row per tag, not every record.
#[tauri::command]
pub(crate) async fn count_tags<R: Runtime>(handle: AppHandle<R>) -> Result<Vec<TagUsage>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || magical_merchant_core::count_tags(&base_dir).map_err(|e| e.to_string()))
        .await
}
