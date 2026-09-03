//! 図の SVG / PNG を、利用者が選んだ場所に書き出す。
//!
//! `WebView` の `<a download>` に任せないのは、macOS の `WKWebView` と Android の
//! `WebView` がそれを処理しないため。保存ダイアログを出して選ばれた先に
//! ネイティブ側で書く。

use std::io::Write as _;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_fs::{FsExt as _, OpenOptions};

#[derive(serde::Serialize)]
pub(crate) struct ExportOutcome {
    /// false はダイアログをキャンセルした。失敗ではない。
    saved: bool,
}

/// ファイル名の拡張子。ダイアログのフィルタと、保存先の種類を決める。
fn extension_of(name: &str) -> Option<&str> {
    let (_, extension) = name.rsplit_once('.')?;
    (!extension.is_empty() && !extension.contains('/')).then_some(extension)
}

/// 保存ダイアログを出し、選ばれた場所に `data_base64` を書く。
///
/// ダイアログは非同期版を使い、結果を oneshot で待つ。`blocking_save_file` は
/// メインスレッドで呼ぶと固まり、同期の Tauri コマンドはメインスレッドで動く。
/// 書き込みは fs プラグイン越し — Android の保存先は `content://` で、
/// `std::fs` では開けない。
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
            // 受け手が居なくなっていても、ダイアログ側にできることは無い
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
        // ディレクトリ名のドットは拡張子ではない
        assert_eq!(extension_of("v1.0/diagram"), None);
    }
}
