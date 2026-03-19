use magical_merchant_core::DeviceContext;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_quick_capture, save_document])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
