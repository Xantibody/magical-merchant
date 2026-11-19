//! The records pointing at a note.

use magical_merchant_core::SearchHit;
use tauri::{AppHandle, Runtime};

use super::note::parse_filename;
use crate::services::tauri::{app_base_dir, off_main_thread};

#[tauri::command]
pub(crate) async fn find_backlinks<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    off_main_thread(move || {
        magical_merchant_core::find_backlinks(&base_dir, &filename).map_err(|e| e.to_string())
    })
    .await
}
