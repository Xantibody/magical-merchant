//! Writing into Scrawl from outside the app (the reach: the app comes to the hand).
//!
//! The desktop registers one key with the OS (38): pressed over any app it floats a small
//! window holding the place pill's own field (`capture.html`, the same words and send button as
//! Scrawl's), and pressed again while that window has the keys it sends what was typed (67). Esc
//! hides the window and the draft stays in it. A `magical-merchant://scrawl?text=…` link writes
//! the line with no window at all (78): that is what a Shortcut run from Spotlight opens. Both
//! tell the main window through one event, so a Scrawl on screen rereads and says what came in.

#[cfg(desktop)]
use tauri::Manager as _;
use tauri::{AppHandle, Emitter};

use crate::{app_base_dir, device};

/// The floating window's label, and the capability that lets its page talk to the app.
#[cfg(desktop)]
const LABEL: &str = "capture";

/// Told to every window after a line was written from outside the main one.
const CAPTURED: &str = "scrawl-captured";

/// What wrote the line, as the main window's toast words it.
#[derive(Clone, serde::Serialize)]
struct Captured {
    via: &'static str,
}

/// The line a `magical-merchant://scrawl` link carries, if it is one. `Some("")` is a link with
/// nothing to write, which opens the window instead.
pub(crate) fn link_text(url: &url::Url) -> Option<String> {
    if url.host_str() != Some("scrawl") {
        return None;
    }
    Some(
        url.query_pairs()
            .find(|(key, _)| key == "text")
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default(),
    )
}

/// Builds the floating window once, hidden. Showing a window already loaded is what lets the
/// key answer at once, with the caret in the field, instead of waiting for a page to boot.
/// Transparent and without a frame: what shows is the pill itself, not a box around it.
#[cfg(desktop)]
fn create(app: &AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("capture.html".into()))
        .title("Scrawl")
        .inner_size(640.0, 132.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .center()
        .build()?;
    Ok(())
}

/// Registers the key with the OS and builds the window it shows. Pressed again while the window
/// has the keys, the same key sends (67). A key another app already holds is not worth failing
/// the start over: the app's own ways to the one line (the ring, the shelf's +) still work.
#[cfg(desktop)]
pub(crate) fn register(app: &AppHandle) -> tauri::Result<()> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt as _, Modifiers, Shortcut, ShortcutState,
    };
    #[cfg(target_os = "macos")]
    let modifier = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let modifier = Modifiers::CONTROL;
    let key = Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::Space);
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &key && event.state() == ShortcutState::Pressed {
                    toggle(app);
                }
            })
            .build(),
    )?;
    if let Err(e) = app.global_shortcut().register(key) {
        eprintln!("the one-line key is taken: {e}");
    }
    create(app)
}

/// The key, pressed: up and focused if it was not, and if it was, the same key sends (67).
#[cfg(desktop)]
fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let up = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if up {
        let _ = app.emit_to(LABEL, "capture://send", ());
        return;
    }
    show(app);
}

/// Shows the window over whatever is in front and hands it the keys.
#[cfg(desktop)]
fn show(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(LABEL, "capture://open", ());
}

/// Floats the window from inside the app (Settings' "try it"): the same window the key shows.
#[tauri::command]
pub(crate) fn capture_window_show(app: AppHandle) {
    #[cfg(desktop)]
    show(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Hides the window; its page keeps the half-typed line for the next time (Esc, a send).
#[tauri::command]
pub(crate) fn capture_window_hide(app: AppHandle) {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Tells the main window a line came in from outside it.
#[tauri::command]
pub(crate) fn capture_window_sent(app: AppHandle) {
    let _ = app.emit(CAPTURED, Captured { via: "window" });
}

/// A Scrawl link from Spotlight or a Shortcut (78): the line is written here, before any page
/// could be asked, so it lands even while the app is still starting. An empty one opens the
/// window. Runs off the main thread: the save probes the device and writes a file.
pub(crate) fn handle_links(app: &AppHandle, urls: &[url::Url]) {
    for text in urls.iter().filter_map(link_text) {
        if text.is_empty() {
            #[cfg(desktop)]
            show(app);
            continue;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            let saved = app_base_dir(&app).and_then(|dir| {
                let context = device::get_context(device::ClientContext::default());
                magical_merchant_core::save_scrawl_entry(
                    &dir,
                    &text,
                    &context,
                    magical_merchant_core::Source::App,
                )
                .map_err(|e| e.to_string())
            });
            if saved.is_ok() {
                let _ = app.emit(CAPTURED, Captured { via: "link" });
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> url::Url {
        url::Url::parse(raw).unwrap()
    }

    #[test]
    fn a_scrawl_link_carries_its_line() {
        assert_eq!(
            link_text(&url("magical-merchant://scrawl?text=%E7%89%9B%E4%B9%B3%20")),
            Some("牛乳".to_string())
        );
    }

    /// A Shortcut with no text asks for the window rather than an empty record
    #[test]
    fn an_empty_scrawl_link_asks_for_the_window() {
        assert_eq!(
            link_text(&url("magical-merchant://scrawl")),
            Some(String::new())
        );
        assert_eq!(
            link_text(&url("magical-merchant://scrawl?text=")),
            Some(String::new())
        );
    }

    /// The auth callback and the widget links share the scheme and must write nothing
    #[test]
    fn other_links_are_not_lines() {
        assert_eq!(
            link_text(&url("magical-merchant://auth/callback?token=x")),
            None
        );
        assert_eq!(
            link_text(&url("magical-merchant://widget/new-note?text=x")),
            None
        );
    }
}
