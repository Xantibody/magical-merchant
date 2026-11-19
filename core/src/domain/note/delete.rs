//! Deleting a note, and with a Codex its versions.

use std::path::Path;

use crate::domain::note::{NoteFilename, NoteKind, locate_note};
use crate::error::CoreError;
use crate::services::files::{remove, remove_dir_all_if_dir};

/// A Codex is deleted together with its versions directory (`codex/<stem>/`).
/// Deleting only the note leaves versions that belong to nobody, and sync
/// keeps distributing them.
pub fn delete_note(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    let (kind, path) = locate_note(base_dir, filename)?;
    remove(&path)?;
    if kind == NoteKind::Codex {
        remove_dir_all_if_dir(&crate::domain::codex::version::versions_dir(
            base_dir, filename,
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::Context;
    use crate::domain::note::{
        Provenance, create_draft_codex, create_draft_note, read_note_meta, update_note_view,
    };
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

    #[test]
    fn test_delete_note_success() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "to delete", &[]).unwrap();
        assert!(path.exists());
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();
        delete_note(tmp.path(), &note_filename).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn test_delete_note_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let note_filename = NoteFilename::parse("nonexistent.md").unwrap();
        let result = delete_note(tmp.path(), &note_filename);
        assert!(matches!(result, Err(CoreError::NotFound(_))));
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

    /// Replacing the frontmatter and deleting reach a Codex by ID alone too.
    #[test]
    fn a_codex_is_edited_and_deleted_by_filename() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "育てる文書");
        let filename = filename_of(&path);
        let versions = tmp.path().join("data/codex/20990101_000000");
        let versions = versions.with_file_name(filename.as_str().trim_end_matches(".md"));
        fs::create_dir_all(&versions).unwrap();
        fs::write(versions.join("20260503_153900-00000000.md"), "v").unwrap();

        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();
        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().view,
            Some("mindmap".to_string())
        );

        delete_note(tmp.path(), &filename).unwrap();

        assert!(!path.exists());
        // The version directory goes with it. Deleting only the note would keep sync
        // delivering the versions
        assert!(!versions.exists());
    }
}
