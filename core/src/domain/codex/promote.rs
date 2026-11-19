//! Promotion: the note panel's one-way action that turns a Note into a Codex.

use std::path::Path;

use crate::domain::note::{NoteFilename, NoteKind, locate_note};
use crate::error::CoreError;
use crate::services::files::{ensure_dir, rename};

/// Turn a note into a Codex.
///
/// Neither the ID nor the content changes; only the location moves to `data/codex/`. There is no
/// entry back: turning a document that has started committing versions back into a plain note would
/// leave its versions belonging to nothing. If it is already a Codex, nothing happens.
///
/// It is a rename within one filesystem, so it is atomic and a concurrent reader never sees
/// a half-way state.
pub fn promote_note_to_codex(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    let (kind, path) = locate_note(base_dir, filename)?;
    if kind == NoteKind::Codex {
        return Ok(());
    }
    let target = NoteKind::Codex.dir(base_dir).join(filename.as_str());
    ensure_dir(&target)?;
    rename(&path, &target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::Context;
    use crate::domain::note::{Provenance, create_draft_codex, create_draft_note, list_notes};
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
}
