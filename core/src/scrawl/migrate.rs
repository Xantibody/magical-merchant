//! A one-time repair that moves `data/timeline/` to `data/scrawl/`.
//!
//! The surface is named Scrawl, but its directory alone kept the pre-rename `timeline`.
//! The name on disk is the sync key as is, so moving it looks to the other devices like
//! "`timeline/*` disappeared and `scrawl/*` appeared": the diff becomes `UploadNew` and
//! `DeleteRemote`, and one sync carries it over in full (`sync/diff.rs`).
//!
//! Call it before the scan. Inside the sync lock (`repair_tree` in `sync/engine.rs`), at app
//! start, at CLI start, in the widget's JNI: every entry point that can write a day file
//! goes through it. Called later, the scan would see a tree halfway through the rename.

use std::fs;
use std::path::Path;

use crate::error::CoreError;
use crate::utils::paths::{SCRAWL_DIR, data_dir};

/// The pre-rename directory. This spelling survives only here, and once the migration is
/// done nobody reads it.
const LEGACY_DIR: &str = "timeline";

/// The result of the move.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScrawlDirMigration {
    /// Number of files moved to the new directory.
    pub moved: usize,
    /// Files left in the old directory because the same name already existed at the target.
    ///
    /// Day files grow by appending, so merging them mechanically loses one side's records.
    /// Left where they are, they keep riding the sync as `timeline/`, but a person can look
    /// at the contents and decide.
    pub left_behind: Vec<String>,
}

impl ScrawlDirMigration {
    /// Whether nothing was moved. Already migrated, or a device that has never written.
    #[must_use]
    pub const fn is_noop(&self) -> bool {
        self.moved == 0 && self.left_behind.is_empty()
    }
}

/// Moves `data/timeline/` to `data/scrawl/` if it exists. Safe to call any number of times.
///
/// If the target does not exist yet, the whole directory is `rename`d: one system call, and
/// a crash midway leaves either "the old one intact in full" or "the new one there in full",
/// nothing else.
///
/// Only when the target already exists (a newer version of the app wrote first) are files
/// carried one by one. A name that collides is neither overwritten nor moved aside under a
/// numbered name; it stays in the old directory.
///
/// # Errors
///
/// When the old directory cannot be read or moved. The caller may swallow it: the next
/// start simply tries again, and nothing is lost.
pub fn migrate_scrawl_dir(base_dir: &Path) -> Result<ScrawlDirMigration, CoreError> {
    let legacy = data_dir(base_dir).join(LEGACY_DIR);
    if !legacy.is_dir() {
        return Ok(ScrawlDirMigration::default());
    }
    let target = data_dir(base_dir).join(SCRAWL_DIR);

    if !target.exists() {
        let moved = fs::read_dir(&legacy)?.count();
        fs::rename(&legacy, &target)?;
        return Ok(ScrawlDirMigration {
            moved,
            left_behind: Vec::new(),
        });
    }

    let mut result = ScrawlDirMigration::default();
    for entry in fs::read_dir(&legacy)? {
        let entry = entry?;
        let name = entry.file_name();
        let landing = target.join(&name);
        if landing.exists() {
            result.left_behind.push(name.to_string_lossy().into_owned());
            continue;
        }
        fs::rename(entry.path(), &landing)?;
        result.moved += 1;
    }
    // Remove the old directory once it is empty. Leaving it cannot make the next sync read
    // the directory alone as "not migrated yet", but to a person it looks as if the
    // migration is not done
    if result.left_behind.is_empty() {
        let _ = fs::remove_dir(&legacy);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn legacy_day(base: &Path, date: &str, body: &str) {
        write(
            &data_dir(base).join(LEGACY_DIR).join(format!("{date}.md")),
            body,
        );
    }

    fn scrawl_day(base: &Path, date: &str, body: &str) {
        write(
            &data_dir(base).join(SCRAWL_DIR).join(format!("{date}.md")),
            body,
        );
    }

    fn read_scrawl_day(base: &Path, date: &str) -> String {
        fs::read_to_string(data_dir(base).join(SCRAWL_DIR).join(format!("{date}.md"))).unwrap()
    }

    #[test]
    fn a_tree_written_before_the_rename_moves_whole() {
        let tmp = TempDir::new().unwrap();
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 朝");
        legacy_day(tmp.path(), "2026-03-21", "- [09:00:00] 翌日");

        let done = migrate_scrawl_dir(tmp.path()).unwrap();

        assert_eq!(done.moved, 2);
        assert!(done.left_behind.is_empty());
        assert_eq!(read_scrawl_day(tmp.path(), "2026-03-20"), "- [09:00:00] 朝");
        assert!(!data_dir(tmp.path()).join(LEGACY_DIR).exists());
    }

    /// It runs on every start, so the premise is that the second run breaks nothing.
    #[test]
    fn running_it_again_changes_nothing() {
        let tmp = TempDir::new().unwrap();
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 朝");

        migrate_scrawl_dir(tmp.path()).unwrap();
        let again = migrate_scrawl_dir(tmp.path()).unwrap();

        assert!(again.is_noop());
        assert_eq!(read_scrawl_day(tmp.path(), "2026-03-20"), "- [09:00:00] 朝");
    }

    /// A device that has never written has no old directory.
    #[test]
    fn a_tree_without_the_old_directory_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        scrawl_day(tmp.path(), "2026-03-20", "- [09:00:00] 朝");

        assert!(migrate_scrawl_dir(tmp.path()).unwrap().is_noop());
        assert_eq!(read_scrawl_day(tmp.path(), "2026-03-20"), "- [09:00:00] 朝");
    }

    /// If a newer version wrote first, the target already exists. Days that do not collide move.
    #[test]
    fn days_that_do_not_collide_move_into_an_existing_directory() {
        let tmp = TempDir::new().unwrap();
        scrawl_day(tmp.path(), "2026-03-21", "- [10:00:00] 新しい版が書いた");
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 古い版が書いた");

        let done = migrate_scrawl_dir(tmp.path()).unwrap();

        assert_eq!(done.moved, 1);
        assert!(done.left_behind.is_empty());
        assert_eq!(
            read_scrawl_day(tmp.path(), "2026-03-20"),
            "- [09:00:00] 古い版が書いた"
        );
        assert_eq!(
            read_scrawl_day(tmp.path(), "2026-03-21"),
            "- [10:00:00] 新しい版が書いた"
        );
    }

    /// The same day exists in both. Day files grow by appending, so merging them loses one
    /// side's records. Keep both and let a person decide.
    #[test]
    fn a_day_that_exists_in_both_is_left_where_it_is() {
        let tmp = TempDir::new().unwrap();
        scrawl_day(tmp.path(), "2026-03-20", "- [10:00:00] 新しい置き場");
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 旧い置き場");

        let done = migrate_scrawl_dir(tmp.path()).unwrap();

        assert_eq!(done.moved, 0);
        assert_eq!(done.left_behind, vec!["2026-03-20.md".to_string()]);
        assert_eq!(
            read_scrawl_day(tmp.path(), "2026-03-20"),
            "- [10:00:00] 新しい置き場"
        );
        assert_eq!(
            fs::read_to_string(data_dir(tmp.path()).join(LEGACY_DIR).join("2026-03-20.md"))
                .unwrap(),
            "- [09:00:00] 旧い置き場"
        );
    }
}
