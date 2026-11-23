//! The records pointing at a note.

use magical_merchant_core::{NoteFilename, SearchHit};
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use crate::services::tauri::{app_base_dir, off_main_thread};

#[tauri::command]
pub(crate) async fn find_backlinks<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<Vec<SearchHit>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    off_main_thread(move || {
        magical_merchant_core::find_backlinks(&base_dir, &filename).map_err(CommandError::from)
    })
    .await
}
