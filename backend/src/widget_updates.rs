//! The commands that ask the launcher to pin a template button. The talking to
//! the widgets is `services::widgets`.

use magical_merchant_core::NoteFilename;

use crate::services::widgets;

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

#[cfg(test)]
mod tests {
    use super::*;

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
