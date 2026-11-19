//! Tauri's webview windows other than the main one: the floating one-line window and the
//! in-app sign-in window.

// Only the desktop build looks up or creates a window here. Android hands the sign-in URL
// to the default browser and has no one-line window, so nothing there uses this trait
#[cfg(desktop)]
use tauri::Emitter as _;
#[cfg(not(target_os = "android"))]
use tauri::Manager as _;
#[cfg(not(target_os = "android"))]
use tauri::{AppHandle, Runtime};

/// The floating window's label, and the capability that lets its page talk to the app.
#[cfg(desktop)]
pub(crate) const CAPTURE_WINDOW_LABEL: &str = "capture";

/// Builds the floating window once, hidden. Showing a window already loaded is what lets the
/// key answer at once, with the caret in the field, instead of waiting for a page to boot.
/// Transparent and without a frame: what shows is the pill itself, not a box around it.
#[cfg(desktop)]
pub(crate) fn create_capture_window(app: &AppHandle) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(
        app,
        CAPTURE_WINDOW_LABEL,
        tauri::WebviewUrl::App("capture.html".into()),
    )
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

/// Shows the window over whatever is in front and hands it the keys.
#[cfg(desktop)]
pub(crate) fn show_capture_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(CAPTURE_WINDOW_LABEL) else {
        return;
    };
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit_to(CAPTURE_WINDOW_LABEL, "capture://open", ());
}

/// Hides the window; its page keeps the half-typed line for the next time.
#[cfg(desktop)]
pub(crate) fn hide_capture_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW_LABEL) {
        let _ = window.hide();
    }
}

/// The in-app window that shows the sign-in page.
///
/// It keeps a single label, and from the second time on the same window is sent to the
/// next URL: `close()` goes through the event loop, so rebuilding with the same label
/// right after closing can collide.
#[cfg(not(target_os = "android"))]
const AUTH_WINDOW_LABEL: &str = "auth";

/// Keeps sign-in inside the app.
///
/// Handing it to an external browser puts the app behind, and after approval the user
/// has to come back on their own. Authentication ends where it started.
#[cfg(not(target_os = "android"))]
pub(crate) fn open_auth_window<R: Runtime>(
    handle: &AppHandle<R>,
    auth_url: &str,
) -> Result<tauri::WebviewWindow<R>, String> {
    let url = url::Url::parse(auth_url).map_err(|e| format!("Invalid auth URL: {e}"))?;

    if let Some(existing) = handle.get_webview_window(AUTH_WINDOW_LABEL) {
        existing
            .navigate(url)
            .map_err(|e| format!("Failed to open the sign-in window: {e}"))?;
        let _ = existing.set_focus();
        return Ok(existing);
    }

    tauri::WebviewWindowBuilder::new(handle, AUTH_WINDOW_LABEL, tauri::WebviewUrl::External(url))
        .title("Sign in")
        .inner_size(520.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to open the sign-in window: {e}"))
}

/// A one-shot receiver that reports the window being closed.
///
/// Waiting on after it is closed would hold a user who meant to stop until the
/// 5-minute timeout.
#[cfg(not(target_os = "android"))]
pub(crate) fn closed_signal<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // `on_window_event` wants an `Fn`, so the one-shot sender is wrapped and taken out
    let tx = std::sync::Mutex::new(Some(tx));
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(());
        }
    });
    rx
}
