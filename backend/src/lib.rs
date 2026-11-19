// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
// `#[tauri::command]` arguments arrive by value: serde deserializes them out of
// the IPC payload, and `AppHandle` / `State` are injected owned. Borrowing them
// is not an option this crate has.
#![allow(clippy::needless_pass_by_value)]

mod commands;
mod device;
mod links;
mod place;
mod services;
#[cfg(desktop)]
mod shortcut;
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

use tauri_plugin_deep_link::DeepLinkExt as _;

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
                    links::on_links(&launch_handle, &urls);
                }
            });

            let handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| links::on_links(&handle, &event.urls()));

            // One key, registered with the OS, floats the one-line window over any app (38)
            #[cfg(desktop)]
            shortcut::register(app.handle())?;

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
            commands::scrawl::capture_window_show,
            commands::scrawl::capture_window_hide,
            commands::scrawl::capture_window_sent,
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
