// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
// `#[tauri::command]` arguments arrive by value: serde deserializes them out of
// the IPC payload, and `AppHandle` / `State` are injected owned. Borrowing them
// is not an option this crate has.
#![allow(clippy::needless_pass_by_value)]

mod auth;
mod device;
mod sync;

use magical_merchant_core::utils::device::Location;
use magical_merchant_core::{NoteFilename, NoteSummary, SearchHit};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt as _;

const fn make_location(latitude: Option<f64>, longitude: Option<f64>) -> Option<Location> {
    match (latitude, longitude) {
        (Some(lat), Some(lng)) => Some(Location {
            latitude: lat,
            longitude: lng,
        }),
        _ => None,
    }
}

#[tauri::command]
fn save_quick_capture(
    handle: AppHandle,
    text: String,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let context = device::get_context(make_location(latitude, longitude));
    magical_merchant_core::save_timeline_entry(&base_dir, &text, &context)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_document(
    handle: AppHandle,
    body: String,
    tags: Vec<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let context = device::get_context(make_location(latitude, longitude));
    magical_merchant_core::create_draft_note(&base_dir, &body, &tags, &context)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn create_draft(
    handle: AppHandle,
    body: String,
    tags: Vec<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<String, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let context = device::get_context(make_location(latitude, longitude));
    let path = magical_merchant_core::create_draft_note(&base_dir, &body, &tags, &context)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn update_draft(
    file_path: String,
    body: String,
    tags: Vec<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
) -> Result<(), String> {
    let context = device::get_context(make_location(latitude, longitude));
    magical_merchant_core::update_note(std::path::Path::new(&file_path), &body, &tags, &context)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_notes(handle: AppHandle) -> Result<Vec<NoteSummary>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::list_notes(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note(handle: AppHandle, filename: String) -> Result<String, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let filename = NoteFilename::parse(&filename).map_err(|e| e.to_string())?;
    magical_merchant_core::read_note_by_filename(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_timeline(handle: AppHandle) -> Result<Vec<String>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().date_naive();
    magical_merchant_core::read_timeline(&base_dir, today).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_timeline_dates(handle: AppHandle) -> Result<Vec<String>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let dates = magical_merchant_core::list_timeline_dates(&base_dir).map_err(|e| e.to_string())?;
    Ok(dates
        .iter()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .collect())
}

#[tauri::command]
fn read_timeline_by_date(handle: AppHandle, date: String) -> Result<Vec<String>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::read_timeline(&base_dir, naive).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_timeline_entry(
    handle: AppHandle,
    date: String,
    index: usize,
    text: String,
) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::update_timeline_entry(&base_dir, naive, index, &text)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_timeline_entry(handle: AppHandle, date: String, index: usize) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::delete_timeline_entry(&base_dir, naive, index).map_err(|e| e.to_string())
}

#[tauri::command]
fn search_all(handle: AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::search_all(&base_dir, &query).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let filename = NoteFilename::parse(&filename).map_err(|e| e.to_string())?;
    magical_merchant_core::delete_note(&base_dir, &filename).map_err(|e| e.to_string())
}

/// OAuth のコールバックで返ってきた JWT を保存する。
/// 保存結果をフロントに通知しないと、ログイン完了が UI に反映されず
/// 失敗も握りつぶされてしまう。
fn store_token_from_urls(handle: &AppHandle, urls: Vec<url::Url>) {
    let Some(token) = urls
        .iter()
        .flat_map(url::Url::query_pairs)
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
    else {
        return;
    };

    let stored = handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| auth::store_token(&dir, &token));

    match stored {
        Ok(()) => {
            let _ = handle.emit("auth-success", ());
        }
        Err(e) => {
            let _ = handle.emit("auth-error", e);
        }
    }
}

// `mobile_entry_point` fixes the signature to `fn run()`, so a failed startup
// has nowhere to be returned to — panicking is the only way to report it.
#[allow(clippy::expect_used)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_opener::init())
        .manage(sync::AppSyncState::default())
        .setup(|app| {
            // ブラウザで認証している間に OS がアプリを回収すると、トークンは
            // 起動 URL として届く。`new-url` イベントはアプリが生きていた場合に
            // しか飛ばないので、両方を見ないとログインが黙って失敗する。
            //
            // get_current は Android プラグインへの同期呼び出しで、応答を運ぶ
            // のは setup と同じメインスレッド。ここで直に待つと Activity ごと
            // 固まる (pause / stop がタイムアウトする) ので別スレッドに逃がす。
            let launch_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(Some(urls)) = launch_handle.deep_link().get_current() {
                    store_token_from_urls(&launch_handle, urls);
                }
            });

            let handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| store_token_from_urls(&handle, event.urls()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_quick_capture,
            save_document,
            create_draft,
            update_draft,
            list_notes,
            read_note,
            read_timeline,
            list_timeline_dates,
            read_timeline_by_date,
            update_timeline_entry,
            delete_timeline_entry,
            search_all,
            delete_note,
            sync::sync_start,
            sync::sync_status,
            auth::auth_login,
            auth::auth_status,
            auth::auth_logout,
            auth::get_sync_config,
            auth::save_sync_config,
            auth::is_sync_config_editable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
