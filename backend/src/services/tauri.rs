//! What the app asks of Tauri itself: where its data lives, and the blocking pool.

use tauri::{AppHandle, Manager, Runtime};

/// Moves reads that sweep every file off the main thread.
///
/// Synchronous commands run on the main thread. Listing, searching and backlinks
/// grow with the number of notes and of days (10 to 30ms for a year's worth,
/// several times that on a real device), and window input and events stop for that
/// long. Run them on the blocking pool and return only the result to the main
/// thread. `resolve_places` goes through here too, for a reason of its own: the
/// geocoder answers on the main queue.
pub(crate) async fn off_main_thread<T, E, F>(work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<String> + Send + 'static,
    F: FnOnce() -> Result<T, E> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| E::from(e.to_string()))?
}

/// Where this app's data lives.
///
/// Notes, the sync settings and the token are all under here and nowhere else.
///
/// Debug builds alone can point it elsewhere with `MAGICAL_MERCHANT_DATA_DIR`. It
/// matches the variable the CLI has had for a while (`cli/src/main.rs`), and it is
/// the way in for trying a new feature without touching real records:
/// `just sandbox` uses it. A shipped app has no need to move its data directory
/// from an environment variable, so the whole branch is gone in release.
pub(crate) fn app_base_dir<R: Runtime>(
    handle: &AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("MAGICAL_MERCHANT_DATA_DIR") {
        return Ok(std::path::PathBuf::from(dir));
    }
    handle.path().app_data_dir().map_err(|e| e.to_string())
}
