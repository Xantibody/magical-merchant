//! Writes a diagram's SVG / PNG out to the place the user picked.
//!
//! The `WebView`'s `<a download>` is not left to do it because macOS's `WKWebView` and
//! Android's `WebView` do not handle it. A save dialog is shown and the native side writes
//! to what was picked.

use std::io::Write as _;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_fs::{FsExt as _, OpenOptions};

#[derive(serde::Serialize)]
pub(crate) struct ExportOutcome {
    /// false means the dialog was cancelled. It is not a failure.
    saved: bool,
}

/// The filename's extension. It decides the dialog's filter and the kind of target.
fn extension_of(name: &str) -> Option<&str> {
    let (_, extension) = name.rsplit_once('.')?;
    (!extension.is_empty() && !extension.contains('/')).then_some(extension)
}

/// Shows a save dialog and writes `data_base64` to the place that was picked.
///
/// The dialog is the async one and the result is awaited on a oneshot.
/// `blocking_save_file` hangs when called on the main thread, and a synchronous Tauri
/// command runs on the main thread. The write goes through the fs plugin: on Android the
/// target is a `content://` URI, which `std::fs` cannot open.
#[tauri::command]
pub(crate) async fn save_export(
    handle: AppHandle,
    suggested_name: String,
    data_base64: String,
) -> Result<ExportOutcome, String> {
    let bytes = B64.decode(data_base64).map_err(|e| e.to_string())?;
    let extension = extension_of(&suggested_name)
        .ok_or_else(|| format!("export name has no extension: {suggested_name}"))?
        .to_owned();

    let (tx, rx) = tokio::sync::oneshot::channel();
    handle
        .dialog()
        .file()
        .add_filter(extension.to_uppercase(), &[&extension])
        .set_file_name(&suggested_name)
        .save_file(move |path| {
            // Even when the receiver is gone, there is nothing the dialog side can do
            let _ = tx.send(path);
        });
    let Some(path) = rx
        .await
        .map_err(|_| "save dialog closed without a result".to_owned())?
    else {
        return Ok(ExportOutcome { saved: false });
    };

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut file = handle.fs().open(path, options).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(ExportOutcome { saved: true })
}

#[cfg(test)]
mod tests {
    use super::extension_of;

    #[test]
    fn extension_is_the_part_after_the_last_dot() {
        assert_eq!(extension_of("20260903_101010-1.svg"), Some("svg"));
        assert_eq!(extension_of("a.b.png"), Some("png"));
    }

    #[test]
    fn a_name_without_an_extension_has_none() {
        assert_eq!(extension_of("diagram"), None);
        assert_eq!(extension_of("diagram."), None);
        // A dot in a directory name is not an extension
        assert_eq!(extension_of("v1.0/diagram"), None);
    }
}
