//! Entry: the desktop's global key (38).
//!
//! Registered with the OS, pressed over any app it floats a small window holding the place
//! pill's own field (`capture.html`, the same words and send button as Scrawl's), and pressed
//! again while that window has the keys it sends what was typed (67). Esc hides the window and
//! the draft stays in it.

use tauri::{AppHandle, Emitter as _, Manager as _};

use crate::services::windows::{CAPTURE_WINDOW_LABEL, create_capture_window, show_capture_window};

/// Registers the key with the OS and builds the window it shows. Pressed again while the window
/// has the keys, the same key sends (67). A key another app already holds is not worth failing
/// the start over: the app's own ways to the one line (the ring, the shelf's +) still work.
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
    create_capture_window(app)
}

/// The key, pressed: up and focused if it was not, and if it was, the same key sends (67).
fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(CAPTURE_WINDOW_LABEL) else {
        return;
    };
    let up = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if up {
        let _ = app.emit_to(CAPTURE_WINDOW_LABEL, "capture://send", ());
        return;
    }
    show_capture_window(app);
}
