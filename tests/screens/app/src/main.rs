//! Entry: the real app as `tests/screens/` drives it. The `WebDriver` server it talks to, a login
//! kept in memory, and the clock it pins so that every shot shows the same day.

// AIDEV-NOTE: debug builds only. The embedded WebDriver server runs any script it is sent, with IPC, and checks no origin (webdriverio/desktop-mobile#1100), and only a debug app reads MAGICAL_MERCHANT_DATA_DIR
#[cfg(not(debug_assertions))]
compile_error!("tests/screens/app is for debug builds only");

mod clock;

use std::sync::Arc;

use tauri::{Builder, Wry, plugin, webview::PageLoadEvent};

/// What `tests/screens/` sets: the instant every `Date` in the webview reads, in milliseconds
/// since the epoch. Unset, the clock runs as usual.
const NOW: &str = "MAGICAL_MERCHANT_NOW_MS";

/// A start with an unreadable pinned instant stops before the window opens, naming the variable.
#[allow(clippy::expect_used)]
fn main() {
    let now = clock::pinned_now(std::env::var(NOW).ok().as_deref()).expect(NOW);
    keep_login_in_memory();
    magical_merchant_app::run_with(|builder| plugins(builder, now));
}

/// The app reads its sync login from the keychain. The item there is this machine's real login,
/// and a fresh build reading it stops the main thread on the OS prompt; an in-memory store
/// starts every shoot signed out instead.
// AIDEV-NOTE: keyring installs the platform store on its first Entry; store_status() makes that happen now, so the mock set after it stays
fn keep_login_in_memory() {
    let _ = keyring::Entry::store_status();
    if let Ok(mock) = keyring_core::mock::Store::new() {
        let store: Arc<keyring_core::CredentialStore> = mock;
        keyring_core::set_default_store(store);
    }
}

/// The main window cannot be resized by hand: a tiling window manager leaves such a window
/// floating where it opened instead of fitting it into its layout, and `WebDriver` still sets its
/// size.
///
/// Every page it loads brings the window to the front with the page focused. `WebKit` matches
/// `:focus` only in a focused page of the key window, so a field shot otherwise has no focus
/// ring, and two shoots would differ by what the user clicked meanwhile.
// AIDEV-NOTE: minimizing the window instead was tried and dropped; the page counts as hidden and WebKit stops the animation frames the ring and the mindmap wait on
fn plugins(builder: Builder<Wry>, now: Option<u64>) -> Builder<Wry> {
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init()).plugin(
        plugin::Builder::<Wry>::new("screens-window")
            .on_window_ready(|window| {
                if window.label() == "main" {
                    let _ = window.set_resizable(false);
                }
            })
            .on_page_load(|webview, payload| {
                if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                    let _ = webview.window().set_focus();
                    let _ = webview.set_focus();
                }
            })
            .build(),
    );
    match now {
        Some(ms) => builder.plugin(
            plugin::Builder::<Wry>::new("screens-clock")
                .js_init_script(clock::clock_script(ms))
                .build(),
        ),
        None => builder,
    }
}
