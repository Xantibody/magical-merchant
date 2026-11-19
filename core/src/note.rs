mod history;
mod repair;
pub(crate) mod repository;
pub(crate) mod version;

pub use history::{Snapshot, list_note_history, read_note_history, restore_note, snapshot_note};
pub(crate) use repository::Notes;
pub use version::{
    BEFORE_RESTORE, DRAFT, Version, VersionStatus, commit_note_version, delete_note_version,
    diff_note_versions, list_note_versions, note_version_status, read_note_version,
    restore_note_version,
};

use std::path::Path;

use crate::domain::note::NoteFilename;
use crate::error::CoreError;

/// Turn a note into a Codex.
///
/// Neither the ID nor the content changes; only the location moves to `data/codex/`. There is no
/// entry back: turning a document that has started committing versions back into a plain note would
/// leave its versions belonging to nothing. If it is already a Codex, nothing happens.
pub fn promote_note_to_codex(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).promote_to_codex(filename)
}

/// Repair garbled metadata that past edits mixed into the body. Returns the number of
/// files repaired.
pub fn repair_notes(base_dir: &Path) -> Result<usize, CoreError> {
    repair::repair_all(&crate::domain::note::kind::notes_dir(base_dir))
}

/// Move conflict copies that an old build put in `data/` to `conflicts/`.
///
/// Returns the count moved. The app calls it once per process at start, and the sync engine calls
/// it under the lock before every scan.
#[must_use]
pub fn relocate_conflict_copies(base_dir: &Path) -> usize {
    repair::relocate_conflict_copies(base_dir)
}

/// If the same ID is in both `notes/` and `codex/`, move the `notes/` side to `conflicts/`.
///
/// Returns the count moved. The sync engine calls it under the lock before the scan and again after
/// a successful run; the app also calls it once per process at start.
#[must_use]
pub fn relocate_duplicate_ids(base_dir: &Path) -> usize {
    repair::relocate_duplicate_ids(base_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::note::{
        NoteKind, Provenance, create_draft_codex, create_draft_note, list_notes,
    };
    use crate::utils::device::Context;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    /// A plain new note that declares nothing. Every test except those about creation
    /// itself goes through this, so adding a provenance kind does not rewrite every test.
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<PathBuf, CoreError> {
        create_draft_note(
            tmp.path(),
            body,
            tags,
            &mock_context(),
            Provenance::default(),
        )
    }

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn codex(tmp: &TempDir, body: &str) -> PathBuf {
        create_draft_codex(
            tmp.path(),
            body,
            &[],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap()
    }

    /// Promotion only changes the location. Neither the ID, the frontmatter nor the body
    /// changes by a byte.
    #[test]
    fn promoting_moves_the_file_without_touching_its_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "育てる #memo", &[]).unwrap();
        let filename = filename_of(&path);
        let before = fs::read(&path).unwrap();

        promote_note_to_codex(tmp.path(), &filename).unwrap();
        promote_note_to_codex(tmp.path(), &filename).unwrap();

        assert!(!path.exists());
        let moved = tmp.path().join("data/codex").join(filename.as_str());
        assert_eq!(fs::read(&moved).unwrap(), before);
        let listed = list_notes(tmp.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, NoteKind::Codex);
        assert_eq!(listed[0].path, moved);
    }

    /// A Codex is already where promotion would put it, so asking again is not a failure
    /// and does not touch the file.
    #[test]
    fn promoting_a_codex_again_changes_nothing() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "育てる文書");
        let filename = filename_of(&path);
        let before = fs::read(&path).unwrap();

        promote_note_to_codex(tmp.path(), &filename).unwrap();

        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(
            !tmp.path()
                .join("data/notes")
                .join(filename.as_str())
                .exists()
        );
    }

    #[test]
    fn promoting_a_missing_note_is_not_found() {
        let tmp = TempDir::new().unwrap();
        let filename = NoteFilename::parse("20260503_153900.md").unwrap();

        let result = promote_note_to_codex(tmp.path(), &filename);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// When a promotion and an offline edit on another device land on the same ID, sync
    /// delivers the notes/ side as a new file. The Codex side stays, and the notes/ side is
    /// set aside in the same place as conflict copies.
    #[test]
    fn a_duplicate_id_in_notes_is_moved_to_conflicts() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "codex 側");
        let filename = filename_of(&path);
        let stale = tmp.path().join("data/notes").join(filename.as_str());
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "notes 側").unwrap();

        assert_eq!(relocate_duplicate_ids(tmp.path()), 1);

        assert!(!stale.exists());
        assert!(fs::read_to_string(&path).unwrap().contains("codex 側"));
        let stem = filename.as_str().trim_end_matches(".md");
        let copies: Vec<_> = fs::read_dir(tmp.path().join("conflicts/notes").join(stem))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read_to_string(copies[0].path()).unwrap(), "notes 側");
        assert_eq!(relocate_duplicate_ids(tmp.path()), 0);
    }
}
