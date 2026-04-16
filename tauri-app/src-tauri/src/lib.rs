use magical_merchant_core::{DeviceContext, NoteSummary, ProjectSummary, TaskSummary};
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

#[tauri::command]
fn create_project(
    handle: AppHandle,
    slug: String,
    name: String,
    description: String,
) -> Result<String, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = magical_merchant_core::create_project(&base_dir, &slug, &name, &description)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_projects(handle: AppHandle) -> Result<Vec<ProjectSummary>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::list_projects(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_task(
    handle: AppHandle,
    project_slug: String,
    title: String,
    tags: Vec<String>,
    body: String,
) -> Result<String, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = magical_merchant_core::create_task(&base_dir, &project_slug, &title, &tags, &body)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_active_tasks(handle: AppHandle, project_slug: String) -> Result<Vec<TaskSummary>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::list_active_tasks(&base_dir, &project_slug).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_done_tasks(handle: AppHandle, project_slug: String) -> Result<Vec<TaskSummary>, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::list_done_tasks(&base_dir, &project_slug).map_err(|e| e.to_string())
}

#[tauri::command]
fn complete_task(handle: AppHandle, project_slug: String, filename: String) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::complete_task(&base_dir, &project_slug, &filename)
        .map_err(|e| e.to_string())
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
fn delete_note(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::delete_note(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_task(handle: AppHandle, project_slug: String, filename: String) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::delete_task(&base_dir, &project_slug, &filename)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_task(
    handle: AppHandle,
    project_slug: String,
    filename: String,
    title: String,
    tags: Vec<String>,
    body: String,
) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    magical_merchant_core::update_task(&base_dir, &project_slug, &filename, &title, &tags, &body)
        .map_err(|e| e.to_string())
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
            create_project,
            list_projects,
            create_task,
            list_active_tasks,
            list_done_tasks,
            complete_task,
            update_task,
            list_timeline_dates,
            read_timeline_by_date,
            delete_note,
            delete_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
