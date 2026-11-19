//! A mock app over a fresh data directory, so a test calls a command as the webview would.

use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::test::{MockRuntime, mock_app};
use tauri::{App, AppHandle};
use tempfile::TempDir;

/// The data directory is one environment variable for the whole process, so the tests
/// that point it somewhere take turns.
static DATA_DIR: Mutex<()> = Mutex::new(());

pub(crate) struct TestApp {
    app: App<MockRuntime>,
    dir: TempDir,
    _turn: MutexGuard<'static, ()>,
}

impl TestApp {
    pub(crate) fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    pub(crate) fn base(&self) -> &Path {
        self.dir.path()
    }
}

/// A mock app whose commands read and write under a temporary directory.
///
/// It panics unless the command side really resolves to that directory: a build that
/// ignores the variable would otherwise write the test's records into the real data.
// AIDEV-NOTE: a command finds the data directory only through `MAGICAL_MERCHANT_DATA_DIR` (`app_base_dir`). Resolving it once at startup as managed state was rejected: Android cannot call `app_data_dir` from the main thread
pub(crate) fn test_app() -> TestApp {
    let turn = DATA_DIR.lock().unwrap_or_else(PoisonError::into_inner);
    let dir = TempDir::new().unwrap();
    std::env::set_var("MAGICAL_MERCHANT_DATA_DIR", dir.path());
    let app = mock_app();

    assert_eq!(
        crate::app_base_dir(app.handle()).unwrap(),
        dir.path(),
        "the commands would not write under the temporary directory"
    );
    TestApp {
        app,
        dir,
        _turn: turn,
    }
}
