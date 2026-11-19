//! Every record, for Browse and for the search field before a word is typed.

use magical_merchant_core::SearchHit;
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use crate::services::tauri::{app_base_dir, off_main_thread};

/// Every record.
///
/// It does not filter by text, so it takes no arguments and the count is not
/// capped: the screen counts kind / tag / period from here. The scan costs the same
/// as `search_all`, so it is called only when the screen opens.
#[tauri::command]
pub(crate) async fn browse_all<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<Vec<SearchHit>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::browse_all(&base_dir).map_err(CommandError::from)
    })
    .await
}

/// The newest records, for the search field before a word is typed. The scan is
/// `browse_all`'s; only the trip to the screen is cut to `limit` rows.
#[tauri::command]
pub(crate) async fn recent_records<R: Runtime>(
    handle: AppHandle<R>,
    limit: usize,
) -> Result<Vec<SearchHit>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::recent_records(&base_dir, limit).map_err(CommandError::from)
    })
    .await
}
