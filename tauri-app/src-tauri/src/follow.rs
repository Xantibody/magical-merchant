//! Follow mode: started with `--follow`, the app shows whichever note an editor beside it
//! names through `magical-merchant follow` (core `follow`, `<base>/follow`).
//!
//! Nothing here raises or focuses the window: the person is typing in the editor, and the
//! app only changes which note it shows.

use std::path::Path;

use notify_debouncer_mini::Debouncer;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use tauri::{AppHandle, Emitter, Manager};

/// Calls `on_follow` with the note's filename each time the follow file names a different
/// one. The base directory is watched without recursion, so notes being written below do
/// not wake it more than once per burst, and anything that does wake it is checked against
/// the last name reported.
pub(crate) fn follow_changes(
    base: &Path,
    mut on_follow: impl FnMut(String) + Send + 'static,
) -> notify_debouncer_mini::notify::Result<Debouncer<RecommendedWatcher>> {
    let owned = base.to_path_buf();
    let mut last = magical_merchant_core::follow::followed(base);
    crate::watch::watch(base, RecursiveMode::NonRecursive, move || {
        let now = magical_merchant_core::follow::followed(&owned);
        if now.is_some() && now != last {
            last.clone_from(&now);
            if let Some(filename) = now {
                on_follow(filename.as_str().to_string());
            }
        }
    })
}

/// Whether this launch asked to follow: `--follow` on the command line, or
/// `MAGICAL_MERCHANT_FOLLOW` set (the way in for `tauri dev`, which owns the arguments).
pub(crate) fn requested() -> bool {
    std::env::args().any(|arg| arg == "--follow")
        || std::env::var_os("MAGICAL_MERCHANT_FOLLOW").is_some_and(|v| !v.is_empty())
}

struct Following {
    // Held only so the watcher lives as long as the app
    _watcher: std::sync::Mutex<Debouncer<RecommendedWatcher>>,
}

const FOLLOW_NOTE: &str = "follow-note";

/// Starts follow mode if this launch asked for it. The note already named when the app starts
/// is picked up by the frontend through `followed_note`, since an event sent now would arrive
/// before anything listens.
pub(crate) fn start(handle: &AppHandle) {
    if !requested() {
        return;
    }
    let base = match crate::app_base_dir(handle) {
        Ok(base) => base,
        Err(e) => {
            eprintln!("follow: no data directory: {e}");
            return;
        }
    };
    let emitter = handle.clone();
    match follow_changes(&base, move |filename| {
        let _ = emitter.emit(FOLLOW_NOTE, filename);
    }) {
        Ok(watcher) => {
            handle.manage(Following {
                _watcher: std::sync::Mutex::new(watcher),
            });
        }
        Err(e) => eprintln!("follow: cannot watch {}: {e}", base.display()),
    }
}

/// The note to open at startup in follow mode; nothing otherwise.
pub(crate) fn followed_note(handle: &AppHandle) -> Option<String> {
    if !requested() {
        return None;
    }
    let base = crate::app_base_dir(handle).ok()?;
    magical_merchant_core::follow::followed(&base).map(|f| f.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use magical_merchant_core::NoteFilename;
    use std::sync::mpsc;
    use std::time::Duration;

    fn name(text: &str) -> NoteFilename {
        NoteFilename::parse(text).unwrap()
    }

    #[test]
    fn a_note_named_in_the_follow_file_is_reported() {
        let base = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = follow_changes(base.path(), move |filename| {
            let _ = tx.send(filename);
        })
        .unwrap();

        magical_merchant_core::follow::follow(base.path(), &name("20260320_143045.md")).unwrap();

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            "20260320_143045.md"
        );
    }

    // Anything else written beside it (the sync lock, places.json) is not a reason to move
    #[test]
    fn other_files_beside_it_report_nothing() {
        let base = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let _watcher = follow_changes(base.path(), move |filename| {
            let _ = tx.send(filename);
        })
        .unwrap();

        std::fs::write(base.path().join("places.json"), "{}").unwrap();

        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());
    }
}
