//! The search field's questions.

use magical_merchant_core::{SearchFilter, SearchHit};
use tauri::{AppHandle, Runtime};

use crate::services::tauri::{app_base_dir, off_main_thread};

#[tauri::command]
pub(crate) async fn search_all<R: Runtime>(
    handle: AppHandle<R>,
    query: String,
    tags: Vec<String>,
) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::search_all(&base_dir, &query, &tags).map_err(|e| e.to_string())
    })
    .await
}

/// The search field's question: `search_all` narrowed by kind and period. The filter goes down
/// to core rather than over the results, because the results are capped.
#[tauri::command]
pub(crate) async fn search_records<R: Runtime>(
    handle: AppHandle<R>,
    query: String,
    tags: Vec<String>,
    filter: SearchFilter,
) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::search_records(&base_dir, &query, &tags, &filter)
            .map_err(|e| e.to_string())
    })
    .await
}
