use magical_merchant_core::{DeviceContext, NoteSummary};
use tauri::{AppHandle, Manager};

#[tauri::command]
fn save_quick_capture(handle: AppHandle, text: String) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let context = DeviceContext::mock();
    magical_merchant_core::save_timeline_entry(&base_dir, &text, &context)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_document(handle: AppHandle, body: String, tags: Vec<String>) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let context = DeviceContext::mock();
    magical_merchant_core::save_note(&base_dir, &body, &tags, &context).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_draft(handle: AppHandle, body: String, tags: Vec<String>) -> Result<String, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let context = DeviceContext::mock();
    let path = magical_merchant_core::create_draft_note(&base_dir, &body, &tags, &context)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn update_draft(file_path: String, body: String, tags: Vec<String>) -> Result<(), String> {
    let context = DeviceContext::mock();
    magical_merchant_core::update_note(std::path::Path::new(&file_path), &body, &tags, &context)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_notes(handle: AppHandle) -> Result<Vec<NoteSummary>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::list_notes(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note(file_path: String) -> Result<String, String> {
    magical_merchant_core::read_note(std::path::Path::new(&file_path)).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_timeline(handle: AppHandle) -> Result<Vec<String>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let today = chrono::Local::now().date_naive();
    magical_merchant_core::read_timeline(&base_dir, today).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_quick_capture,
            save_document,
            create_draft,
            update_draft,
            list_notes,
            read_note,
            read_timeline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
