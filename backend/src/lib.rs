// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
// `#[tauri::command]` arguments arrive by value: serde deserializes them out of
// the IPC payload, and `AppHandle` / `State` are injected owned. Borrowing them
// is not an option this crate has.
#![allow(clippy::needless_pass_by_value)]

mod capture;
mod commands;
mod device;
mod place;
mod services;
#[cfg(test)]
mod test_app;
// Public because it is a real external surface: the JNI symbol inside is what
// the Android widget links against, and `unreachable_pub` is right that a
// private module cannot hold one honestly.
#[cfg(target_os = "android")]
pub mod widget_bridge;
// Only the Android JNI bridge reads this, but it is built everywhere so its
// tests run: CI has no Android target, and the parsing is the part worth
// testing.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod widget_summary;

use services::tauri::app_base_dir;
use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt as _;

/// Takes from a deep link only the JWT that may be stored.
///
/// The widget's own `magical-merchant://widget/` links arrive on the same scheme,
/// so a `?token=` alone is not enough. Only links whose host is `auth` count, and
/// the value has to be a live JWT as well: storing an expired one overwrites a
/// valid token and leaves the next sync stopped at "please log in again"
fn token_from_urls(urls: &[url::Url]) -> Option<String> {
    urls.iter()
        .filter(|url| url.host_str() == Some("auth"))
        .flat_map(url::Url::query_pairs)
        .filter(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .find(|token| magical_merchant_core::domain::sync::token::is_token_valid(token))
}

/// Stores the JWT that came back from the OAuth callback.
///
/// Without telling the frontend the result, a completed login never reaches the UI
/// and a failure is swallowed.
///
/// On Android `app_data_dir` is a synchronous call into a plugin, and the main
/// thread is what carries its reply. Deep link events are delivered on that same
/// main thread, so calling it directly here waits on its own reply and freezes the
/// whole Activity. Always move it to another thread.
fn store_token_from_urls(handle: &AppHandle, urls: &[url::Url]) {
    let Some(token) = token_from_urls(urls) else {
        return;
    };

    let handle = handle.clone();
    std::thread::spawn(move || {
        let stored = app_base_dir(&handle)
            .and_then(|dir| magical_merchant_core::domain::sync::login::store_token(&dir, &token));

        match stored {
            Ok(()) => {
                let _ = handle.emit("auth-success", ());
            }
            Err(e) => {
                let _ = handle.emit("auth-error", e);
            }
        }
    });
}

/// Every link the app is opened with: the login's callback, and a Scrawl line from Spotlight or
/// a Shortcut (78), which is written before any page could be asked.
fn on_links(handle: &AppHandle, urls: &[url::Url]) {
    store_token_from_urls(handle, urls);
    capture::handle_links(handle, urls);
}

// `mobile_entry_point` fixes the signature to `fn run()`, so a failed startup
// has nowhere to be returned to — panicking is the only way to report it.
// `generate_context!` embeds every plugin's permission tables in one value;
// with dialog and fs on board it crosses clippy's stack-frame threshold. It
// is built once at startup, so the frame size is not a concern.
#[allow(clippy::expect_used, clippy::large_stack_frames)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_opener::init())
        // Diagram export: the save dialog, and writing to content:// on Android
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(commands::sync::run::AppSyncState::default())
        .setup(|app| {
            // Android has nothing listening for `log`, and warnings from dependency
            // crates are thrown away. The rustls-platform-verifier that android_tls
            // below uses writes the reason it rejected a certificate here and
            // nowhere else, so initialise this before that. Release stops at Warn
            // because going down to Debug fills logcat with dependency crates'
            // routine logs and the one line that matters scrolls away.
            #[cfg(target_os = "android")]
            android_logger::init_once(
                android_logger::Config::default()
                    .with_max_level(if cfg!(debug_assertions) {
                        log::LevelFilter::Debug
                    } else {
                        log::LevelFilter::Warn
                    })
                    .with_tag("magical-merchant"),
            );

            // If the OS reclaims the app while the browser is authenticating, the
            // token arrives as the launch URL. The `new-url` event only fires when
            // the app stayed alive, so a login fails silently unless both are read.
            //
            // get_current is a synchronous plugin call too, so do not wait on it
            // inside setup.
            let launch_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(Some(urls)) = launch_handle.deep_link().get_current() {
                    on_links(&launch_handle, &urls);
                }
            });

            let handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| on_links(&handle, &event.urls()));

            // One key, registered with the OS, floats the one-line window over any app (38)
            #[cfg(desktop)]
            capture::register(app.handle())?;

            // There is a gap between starting to locate and the first fix coming
            // back. Asking on every save is too late, so start receiving at launch.
            #[cfg(target_os = "macos")]
            services::core_location::start(app.handle());

            // The geocoder and the certificate verifier need a Context. The Activity
            // can be destroyed, so hold an Application Context of our own while one
            // is alive.
            #[cfg(target_os = "android")]
            if let Err(e) = services::android::init() {
                log::error!("android context init failed: {e}");
            }

            // Android's trust store is reachable only from Java, so the platform
            // verifier has to be initialised before any HTTPS request. Sync itself
            // goes around it today (`services::android_tls::sync_tls_config`); the wiring
            // stays so it works again once upstream #221 is fixed.
            #[cfg(target_os = "android")]
            services::android_tls::init();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::scrawl::save_quick_capture,
            capture::capture_window_show,
            capture::capture_window_hide,
            capture::capture_window_sent,
            commands::note::create_draft,
            commands::codex::promote_note_to_codex,
            commands::codex::commit_note_version,
            commands::codex::list_note_versions,
            commands::codex::read_note_version,
            commands::codex::diff_note_versions,
            commands::codex::restore_note_version,
            commands::codex::delete_note_version,
            commands::codex::note_version_status,
            commands::note::update_draft,
            commands::note::list_notes,
            commands::note::read_note,
            commands::note::read_note_meta,
            commands::backlinks::find_backlinks,
            commands::note::update_note_meta,
            commands::note::set_note_origin,
            commands::note::set_note_view,
            commands::templates::list_templates,
            commands::templates::read_template,
            commands::templates::save_template,
            commands::templates::delete_template,
            commands::templates::rename_template,
            commands::templates::save_template_draft,
            commands::templates::read_template_draft,
            commands::templates::discard_template_draft,
            commands::templates::list_template_drafts,
            commands::templates::create_from_template,
            commands::glyphs::list_glyphs,
            commands::glyphs::read_glyphs,
            commands::glyphs::save_glyph,
            commands::glyphs::delete_glyph,
            commands::scrawl::list_scrawl_dates,
            commands::scrawl::read_scrawl_by_date,
            commands::scrawl::read_scrawl_days,
            commands::scrawl::delete_scrawl_entry,
            commands::search::search_all,
            commands::search::search_records,
            commands::browse::browse_all,
            commands::browse::recent_records,
            commands::tags::count_tags,
            commands::device::resolve_places,
            commands::note::delete_note,
            commands::markdown::save_export,
            commands::templates::template_widget_pinnable,
            commands::templates::pin_template_widget,
            commands::sync::run::sync_start,
            commands::sync::run::sync_status,
            commands::sync::login::auth_login,
            commands::sync::login::auth_status,
            commands::sync::login::auth_logout,
            commands::sync::settings::get_sync_config,
            commands::sync::settings::save_sync_config,
            commands::sync::settings::is_sync_config_editable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// Nobody checks the signature (same reason as `domain::sync::token::is_token_valid`),
    /// so the three parts are assembled directly
    fn jwt(expires_in: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let exp = magical_merchant_core::utils::clock::unix_seconds_now() + expires_in;
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    fn urls(raw: &[String]) -> Vec<url::Url> {
        raw.iter().map(|u| url::Url::parse(u).unwrap()).collect()
    }

    #[test]
    fn the_auth_callback_token_is_taken() {
        let token = jwt(3600);
        let links = urls(&[format!("magical-merchant://auth/callback?token={token}")]);

        assert_eq!(token_from_urls(&links), Some(token));
    }

    /// A widget deep link arrives on the same scheme. Adding a `?token=` must not
    /// be enough to swap the account things are saved to
    #[test]
    fn a_token_on_a_widget_link_is_ignored() {
        let links = urls(&[format!(
            "magical-merchant://widget/new-note?token={}",
            jwt(3600)
        )]);

        assert_eq!(token_from_urls(&links), None);
    }

    /// Storing an expired token leaves nothing but a state where the next sync
    /// stops at "please log in again", with the valid token overwritten as well
    #[test]
    fn an_expired_or_malformed_token_is_ignored() {
        let expired = urls(&[format!(
            "magical-merchant://auth/callback?token={}",
            jwt(-100)
        )]);
        let garbage = urls(&["magical-merchant://auth/callback?token=not-a-jwt".to_string()]);

        assert_eq!(token_from_urls(&expired), None);
        assert_eq!(token_from_urls(&garbage), None);
    }
}
