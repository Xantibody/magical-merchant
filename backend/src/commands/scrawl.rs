//! The commands the Scrawl screen, its input line and the floating one-line window call.

use magical_merchant_core::domain::device::{ClientContext, probe_with_client};
use magical_merchant_core::utils::clock::Day;
use magical_merchant_core::{ScrawlDays, Source};
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use crate::services::core_location;
use crate::services::tauri::{app_base_dir, off_main_thread};
use crate::services::windows::tell_scrawl_captured;
#[cfg(desktop)]
use crate::services::windows::{hide_capture_window, show_capture_window};

#[tauri::command]
pub(crate) fn save_quick_capture<R: Runtime>(
    handle: AppHandle<R>,
    text: String,
    client: ClientContext,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let context = probe_with_client(client, core_location::latest);
    magical_merchant_core::save_scrawl_entry(&base_dir, &text, &context, Source::App)
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn list_scrawl_dates<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<Vec<String>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let dates = magical_merchant_core::list_scrawl_dates(&base_dir)?;
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
) -> Result<ScrawlDays, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::read_scrawl_days(&base_dir, recent, &extra)
            .map_err(CommandError::from)
    })
    .await
}

#[tauri::command]
pub(crate) fn read_scrawl_by_date<R: Runtime>(
    handle: AppHandle<R>,
    date: String,
) -> Result<Vec<String>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let naive = Day::parse_ymd(&date)?;
    magical_merchant_core::read_scrawl(&base_dir, naive).map_err(CommandError::from)
}

/// `raw` is the line as the screen read it. With the index it names which record.
#[tauri::command]
pub(crate) fn delete_scrawl_entry<R: Runtime>(
    handle: AppHandle<R>,
    date: String,
    index: usize,
    raw: String,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let naive = Day::parse_ymd(&date)?;
    magical_merchant_core::delete_scrawl_entry(&base_dir, naive, index, &raw)
        .map_err(CommandError::from)
}

/// Floats the one-line window from inside the app (Settings' "try it"): the same window the
/// global key shows.
#[tauri::command]
pub(crate) fn capture_window_show(app: AppHandle) {
    #[cfg(desktop)]
    show_capture_window(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Hides the window; its page keeps the half-typed line for the next time (Esc, a send).
#[tauri::command]
pub(crate) fn capture_window_hide(app: AppHandle) {
    #[cfg(desktop)]
    hide_capture_window(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Tells the main window a line came in from outside it.
#[tauri::command]
pub(crate) fn capture_window_sent(app: AppHandle) {
    tell_scrawl_captured(&app, "window");
}
