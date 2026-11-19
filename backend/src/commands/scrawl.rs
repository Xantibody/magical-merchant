//! The commands the Scrawl screen and its input line call.

use magical_merchant_core::utils::clock::Day;
use magical_merchant_core::{ScrawlDays, Source};
use tauri::{AppHandle, Runtime};

use crate::device::{self, ClientContext};
use crate::services::tauri::{app_base_dir, off_main_thread};

#[tauri::command]
pub(crate) fn save_quick_capture<R: Runtime>(
    handle: AppHandle<R>,
    text: String,
    client: ClientContext,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let context = device::get_context(client);
    magical_merchant_core::save_scrawl_entry(&base_dir, &text, &context, Source::App)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn list_scrawl_dates<R: Runtime>(handle: AppHandle<R>) -> Result<Vec<String>, String> {
    let base_dir = app_base_dir(&handle)?;
    let dates = magical_merchant_core::list_scrawl_dates(&base_dir).map_err(|e| e.to_string())?;
    Ok(dates.iter().map(Day::ymd).collect())
}

/// What the Scrawl screen draws when it opens: the date list and the newest `recent`
/// days, plus the older days named in `extra`.
///
/// One call off the main thread in place of the date list and one call per day, each
/// of which ran on it. It only reads, like `read_scrawl_by_date`.
#[tauri::command]
pub(crate) async fn read_scrawl_days<R: Runtime>(
    handle: AppHandle<R>,
    recent: usize,
    extra: Vec<Day>,
) -> Result<ScrawlDays, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::read_scrawl_days(&base_dir, recent, &extra)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) fn read_scrawl_by_date<R: Runtime>(
    handle: AppHandle<R>,
    date: String,
) -> Result<Vec<String>, String> {
    let base_dir = app_base_dir(&handle)?;
    let naive = Day::parse_ymd(&date).map_err(|e| e.to_string())?;
    magical_merchant_core::read_scrawl(&base_dir, naive).map_err(|e| e.to_string())
}

/// `raw` is the line as the screen read it. With the index it names which record.
#[tauri::command]
pub(crate) fn delete_scrawl_entry<R: Runtime>(
    handle: AppHandle<R>,
    date: String,
    index: usize,
    raw: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let naive = Day::parse_ymd(&date).map_err(|e| e.to_string())?;
    magical_merchant_core::delete_scrawl_entry(&base_dir, naive, index, &raw)
        .map_err(|e| e.to_string())
}
