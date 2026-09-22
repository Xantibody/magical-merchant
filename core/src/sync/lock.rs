//! Cross-process mutual exclusion for sync.
//!
//! The app's "syncing" flag (`AtomicBool`) only works inside one process.
//! When two syncs run at once, they overwrite `.sync-state.json` last-writer-wins, and a
//! key that `to_local_state` dropped as "not on disk" vanishes from the other's state.
//! On the next sync it comes back as a difference and becomes a false conflict copy
//! (`diff.rs`). The exclusion has to span processes, so it lives on the filesystem.
//!
//! Two things start a sync, the app and the CLI's `sync`, and they can run at the same
//! time from separate processes. The one that comes second is refused with `kind: "busy"`.

use std::fs::{self, File, TryLockError};
use std::path::Path;

use super::SyncError;

/// Kept outside `data/`. Inside, the lock file itself would become a sync target.
const LOCK_FILENAME: &str = ".sync.lock";

/// Syncing is allowed only while this is alive. Dropping it releases the lock.
///
/// The lock itself is an advisory lock on the open file descriptor, so the OS reliably
/// removes it whether the process dies from a panic or gets killed.
/// Nobody has to delete "a lock file left over from the last crash" by hand.
#[derive(Debug)]
pub struct SyncLock {
    file: File,
}

impl SyncLock {
    /// Returns `busy` without waiting when the lock cannot be taken.
    /// The next write runs a sync again anyway, so skipping is cheaper than freezing in a queue.
    pub fn acquire(base_dir: &Path) -> Result<Self, SyncError> {
        // Right after the first launch the app data directory itself may not exist yet
        fs::create_dir_all(base_dir).map_err(|e| {
            SyncError::other(format!(
                "Failed to prepare the sync lock directory ({}): {e}",
                base_dir.display()
            ))
        })?;

        let path = base_dir.join(LOCK_FILENAME);
        // Neither truncate nor delete. The lock itself carries the meaning, not the
        // content, and deleting or truncating would let the side without the lock touch
        // the file of the side that holds it
        let file = File::options()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| {
                SyncError::other(format!(
                    "Failed to open the sync lock ({}): {e}",
                    path.display()
                ))
            })?;

        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(TryLockError::WouldBlock) => Err(SyncError::new(
                "busy",
                "Another sync is already running. Try again in a moment.",
            )),
            // No sync when it is unclear whether the lock was taken.
            // Going ahead without exclusion costs more
            Err(TryLockError::Error(e)) => Err(SyncError::other(format!(
                "Failed to lock {}: {e}",
                path.display()
            ))),
        }
    }
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        // Closing the file releases it too, but this makes explicit that this type owns the release
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::{LOCK_FILENAME, SyncLock};
    use std::path::Path;
    use std::process::Command;

    /// Tells the child process which directory to try to lock.
    const CHILD_DIR_ENV: &str = "MM_SYNC_LOCK_TEST_DIR";
    /// The binary relaunches itself, so the test name is the child process's entry point.
    const CHILD_TEST: &str = "sync::lock::tests::a_second_process_cannot_take_a_held_lock";

    #[test]
    fn the_lock_file_lives_outside_the_synced_tree() {
        let dir = tempfile::tempdir().unwrap();
        let _lock = SyncLock::acquire(dir.path()).unwrap();

        assert!(dir.path().join(LOCK_FILENAME).exists());
        assert!(!dir.path().join("data").exists());
    }

    #[test]
    fn the_lock_is_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _lock = SyncLock::acquire(dir.path()).unwrap();
        }

        assert!(SyncLock::acquire(dir.path()).is_ok());
    }

    /// Running two threads would not prove "across processes", so this launches one more
    /// copy of the test binary and runs this same test as the child.
    #[test]
    fn a_second_process_cannot_take_a_held_lock() {
        // The side launched as the child. It tries the lock and reports the result to the parent
        if let Ok(dir) = std::env::var(CHILD_DIR_ENV) {
            match SyncLock::acquire(Path::new(&dir)) {
                Ok(_) => println!("child: acquired"),
                Err(e) => println!("child: {}", e.kind),
            }
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let _held = SyncLock::acquire(dir.path()).unwrap();

        let out = Command::new(std::env::current_exe().unwrap())
            .args([CHILD_TEST, "--exact", "--nocapture"])
            .env(CHILD_DIR_ENV, dir.path())
            .output()
            .unwrap();

        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("child: busy"),
            "the child process should have been refused; it said:\n{stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// So the test above cannot degrade into "meant to launch a child but ran nothing",
    /// this also checks that the child can take the lock when it is free.
    #[test]
    fn a_second_process_takes_a_free_lock() {
        let dir = tempfile::tempdir().unwrap();

        let out = Command::new(std::env::current_exe().unwrap())
            .args([CHILD_TEST, "--exact", "--nocapture"])
            .env(CHILD_DIR_ENV, dir.path())
            .output()
            .unwrap();

        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("child: acquired"),
            "the child process should have taken the free lock; it said:\n{stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
