//! Watches `data/` so a write from outside the app — the CLI, an editor plugin, MCP —
//! reaches the screen without waiting for the window to be focused again.

use std::path::Path;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use tauri::{AppHandle, Emitter, Manager};

/// How long a burst of events is gathered before it is reported once. An atomic write is
/// several events (create, write, rename); short enough that an editor beside the app still
/// feels live.
const SETTLE: Duration = Duration::from_millis(150);

/// Calls `on_change` once per settled burst of changes anywhere under `dir`. Watching stops
/// when the returned value is dropped.
pub(crate) fn watch(
    dir: &Path,
    mut on_change: impl FnMut() + Send + 'static,
) -> notify_debouncer_mini::notify::Result<Debouncer<RecommendedWatcher>> {
    let mut debouncer = new_debouncer(SETTLE, move |result: DebounceEventResult| {
        if result.is_ok_and(|events| !events.is_empty()) {
            on_change();
        }
    })?;
    debouncer.watcher().watch(dir, RecursiveMode::Recursive)?;
    Ok(debouncer)
}

/// Keeps the watcher alive for as long as the app runs.
struct Watching {
    // Held only so dropping it never happens while the app runs
    _watcher: std::sync::Mutex<Debouncer<RecommendedWatcher>>,
}

/// Starts watching the app's `data/` and tells the frontend through `data-changed`.
///
/// The app's own saves come back through here as well; the frontend drops a reread whose
/// revision is already on screen (`lib/note-session.ts`). A failure only costs the live
/// update — the window's focus still rereads — so it is logged and passed over.
pub(crate) fn start(handle: &AppHandle) {
    let data = match crate::app_base_dir(handle) {
        Ok(base) => magical_merchant_core::utils::paths::data_dir(&base),
        Err(e) => {
            eprintln!("data watch: no data directory: {e}");
            return;
        }
    };
    // A first launch has no `data/` yet, and a path that does not exist cannot be watched
    if let Err(e) = std::fs::create_dir_all(&data) {
        eprintln!("data watch: cannot create {}: {e}", data.display());
        return;
    }
    let emitter = handle.clone();
    match watch(&data, move || {
        let _ = emitter.emit(DATA_CHANGED, ());
    }) {
        Ok(watcher) => {
            handle.manage(Watching {
                _watcher: std::sync::Mutex::new(watcher),
            });
        }
        Err(e) => eprintln!("data watch: cannot watch {}: {e}", data.display()),
    }
}

const DATA_CHANGED: &str = "data-changed";

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn a_file_written_under_the_directory_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = watch(dir.path(), move || {
            let _ = tx.send(());
        })
        .unwrap();

        std::fs::write(dir.path().join("20260928_120000.md"), "# a").unwrap();

        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
    }
}
