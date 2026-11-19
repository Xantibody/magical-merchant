//! The commands that register glyphs and hand them to the screen.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use magical_merchant_core::{GlyphFormat, GlyphName, GlyphSummary};
use tauri::{AppHandle, Runtime};

use crate::services::tauri::{app_base_dir, off_main_thread};

fn parse_glyph_name(name: &str) -> Result<GlyphName, String> {
    GlyphName::parse(name).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn list_glyphs<R: Runtime>(handle: AppHandle<R>) -> Result<Vec<GlyphSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_glyphs(&base_dir).map_err(|e| e.to_string())
}

/// One entry, looked up when the screen draws `:name:`.
#[derive(serde::Serialize)]
pub(crate) struct GlyphAsset {
    name: String,
    /// `data:image/...;base64,...`.
    url: String,
}

/// Returns every registered glyph as a data URL.
///
/// They come back in one call so the screen can look a name up synchronously while
/// it draws the body. They are not served over the asset protocol or a custom
/// scheme because that way no new capability has to be opened, and the browser
/// harness can imitate it as it is.
///
/// It is read again on every return to the window, and each call opens and
/// encodes every image, so it runs off the main thread like the other sweeps.
#[tauri::command]
pub(crate) async fn read_glyphs<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<Vec<GlyphAsset>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        let mut assets = Vec::new();
        for summary in magical_merchant_core::list_glyphs(&base_dir).map_err(|e| e.to_string())? {
            // Do not fail all of them over one glyph deleted right after it was listed
            let Ok(name) = GlyphName::parse(&summary.name) else {
                continue;
            };
            let Ok(glyph) = magical_merchant_core::read_glyph(&base_dir, &name) else {
                continue;
            };
            assets.push(GlyphAsset {
                name: summary.name,
                url: format!(
                    "data:{};base64,{}",
                    glyph.format.mime(),
                    B64.encode(&glyph.bytes)
                ),
            });
        }
        Ok(assets)
    })
    .await
}

#[tauri::command]
pub(crate) fn save_glyph<R: Runtime>(
    handle: AppHandle<R>,
    name: String,
    format: String,
    data_base64: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let name = parse_glyph_name(&name)?;
    let format = GlyphFormat::parse(&format).map_err(|e| e.to_string())?;
    let bytes = B64.decode(data_base64).map_err(|e| e.to_string())?;
    magical_merchant_core::save_glyph(&base_dir, &name, format, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn delete_glyph<R: Runtime>(handle: AppHandle<R>, name: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let name = parse_glyph_name(&name)?;
    magical_merchant_core::delete_glyph(&base_dir, &name).map_err(|e| e.to_string())
}

/// What the webview gets back, called through a mock app over a temporary data directory.
#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "a test app holds the data directory until the test ends"
)]
mod tests {
    use super::*;
    use crate::test_app::test_app;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>";

    #[test]
    fn read_glyphs_answers_each_image_as_a_data_url() {
        let app = test_app();
        for (name, format, bytes) in [("dot", "png", PNG), ("ring", "svg", SVG)] {
            save_glyph(
                app.handle(),
                name.to_string(),
                format.to_string(),
                B64.encode(bytes),
            )
            .unwrap();
        }

        let mut assets = tauri::async_runtime::block_on(read_glyphs(app.handle())).unwrap();
        assets.sort_by(|a, b| a.name.cmp(&b.name));

        let urls: Vec<(&str, String)> = assets
            .iter()
            .map(|asset| (asset.name.as_str(), asset.url.clone()))
            .collect();
        assert_eq!(
            urls,
            [
                ("dot", format!("data:image/png;base64,{}", B64.encode(PNG))),
                (
                    "ring",
                    format!("data:image/svg+xml;base64,{}", B64.encode(SVG))
                ),
            ]
        );
    }
}
