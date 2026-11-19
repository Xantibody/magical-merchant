//! The commands the Templates screen and the ring call, and the ones that pin a template
//! button on the Android home screen.

use magical_merchant_core::domain::device::{ClientContext, probe_with_client};
use magical_merchant_core::{
    CreatedNote, NoteFilename, Provenance, Source, TemplateDetail, TemplateSummary, VarLocale,
};
use tauri::{AppHandle, Runtime};

use super::note::parse_filename;
use crate::services::core_location;
use crate::services::tauri::app_base_dir;
use crate::services::widgets;

#[tauri::command]
pub(crate) fn list_templates<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<Vec<TemplateSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_templates(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn read_template<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<TemplateDetail, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_template(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn save_template<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    body: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::save_template(&base_dir, &filename, &body, &tags)
        .map_err(|e| e.to_string())?;
    widgets::refresh_templates();
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_template<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::delete_template(&base_dir, &filename).map_err(|e| e.to_string())?;
    widgets::refresh_templates();
    Ok(())
}

/// Renames a template and its draft. Refused when the new name is taken.
#[tauri::command]
pub(crate) fn rename_template<R: Runtime>(
    handle: AppHandle<R>,
    from: String,
    to: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let from = parse_filename(&from)?;
    let to = parse_filename(&to)?;
    magical_merchant_core::rename_template(&base_dir, &from, &to).map_err(|e| e.to_string())
}

/// Keeps the edit in progress beside the template. Returns whether a draft is left: one
/// equal to the saved template is removed instead.
#[tauri::command]
pub(crate) fn save_template_draft<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    body: String,
    tags: Vec<String>,
) -> Result<bool, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::save_template_draft(&base_dir, &filename, &TemplateDetail { body, tags })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn read_template_draft<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<Option<TemplateDetail>, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_template_draft(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn discard_template_draft<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::discard_template_draft(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn list_template_drafts<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<Vec<TemplateSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_template_drafts(&base_dir).map_err(|e| e.to_string())
}

/// Creates a note from a template. Every call makes a new note.
///
/// It takes `locale` for `{{weekday}}`. Only the names of the days should follow
/// the device language, and the screen is the only side that knows that language.
#[tauri::command]
pub(crate) fn create_from_template<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    client: ClientContext,
    locale: String,
) -> Result<CreatedNote, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    let context = probe_with_client(client, core_location::latest);
    let created = magical_merchant_core::create_note_from_template(
        &base_dir,
        &filename,
        &context,
        VarLocale::parse(&locale),
        Provenance {
            source: Some(Source::App),
            ..Provenance::default()
        },
    )
    .map_err(|e| e.to_string())?;
    widgets::refresh_templates();
    Ok(created)
}

/// Whether this device's launcher can place a widget on request.
#[tauri::command]
pub(crate) fn template_widget_pinnable() -> bool {
    widgets::can_pin()
}

/// Asks the launcher to place a button for the template `filename`.
///
/// `true` means the request went out; the system shows its own confirmation, and
/// declining there is not reported back. `false` means this device cannot pin.
#[tauri::command]
pub(crate) fn pin_template_widget(filename: String) -> Result<bool, String> {
    let filename = NoteFilename::parse(&filename).map_err(|e| e.to_string())?;
    Ok(widgets::request_pin(template_name(&filename)))
}

/// The name a widget stores and puts on its deep link: the filename minus `.md`,
/// the same value a note made from the template records.
fn template_name(filename: &NoteFilename) -> &str {
    let name = filename.as_str();
    name.strip_suffix(".md").unwrap_or(name)
}

/// What the webview gets back, called through a mock app over a temporary data directory.
#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "a test app holds the data directory until the test ends"
)]
mod tests {
    use super::*;
    use crate::commands::note::{NoteRead, read_note};
    use crate::test_app::{TestApp, test_app};

    fn client() -> ClientContext {
        ClientContext::default()
    }

    fn read(app: &TestApp, filename: &str) -> NoteRead {
        read_note(app.handle(), filename.to_string()).unwrap()
    }

    #[test]
    fn create_from_template_answers_the_id_of_the_note_it_made() {
        let app = test_app();
        save_template(
            app.handle(),
            "daily.md".to_string(),
            "# Daily".to_string(),
            vec![],
        )
        .unwrap();

        let created = create_from_template(
            app.handle(),
            "daily.md".to_string(),
            client(),
            "en".to_string(),
        )
        .unwrap();

        let json = serde_json::to_value(&created).unwrap();
        let filename = json["filename"].as_str().unwrap();
        assert_eq!(json, serde_json::json!({ "filename": filename }));
        assert_eq!(read(&app, filename).body, "# Daily");
    }

    #[test]
    fn the_widget_is_told_the_name_not_the_filename() {
        let filename = NoteFilename::parse("daily.md").unwrap();
        assert_eq!(template_name(&filename), "daily");
    }

    /// Off Android there is nothing to pin to; the menu entry reads this to hide itself.
    #[test]
    fn pinning_is_unsupported_off_android() {
        assert!(!template_widget_pinnable());
        assert_eq!(pin_template_widget("daily.md".to_string()), Ok(false));
    }

    #[test]
    fn a_bad_filename_is_refused() {
        assert!(pin_template_widget("../x.md".to_string()).is_err());
    }
}
