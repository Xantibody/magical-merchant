//! Opening a note: finding it by ID, and reading its body or its record.

use std::path::{Path, PathBuf};

use crate::domain::note::{NoteFilename, NoteFrontmatter, NoteKind};
use crate::services::files::{read_text, resolve_existing};
use crate::utils::error::CoreError;
use crate::utils::frontmatter;

/// Look up a note's kind and actual location from its ID.
///
/// Entries that rewrite the body (CLI, MCP) pass the path obtained here to
/// [`crate::update_note`]: hardcoding `notes/` would make a note turned into a Codex
/// "missing", or recreate a plain note beside it.
///
/// The directory it is found in is its kind. Codex is checked first so that, when sync
/// brings back the old `notes/` copy right after a promotion, the Codex one is opened:
/// the side with committed versions is the real one, and the returned copy is cleaned up
/// by `relocate_duplicate_ids`.
pub fn locate_note(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<(NoteKind, PathBuf), CoreError> {
    for kind in [NoteKind::Codex, NoteKind::Note] {
        match resolve_existing(&kind.dir(base_dir), filename.as_str()) {
            Ok(path) => return Ok((kind, path)),
            Err(CoreError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
    }
    Err(CoreError::NotFound(
        NoteKind::Note
            .dir(base_dir)
            .join(filename.as_str())
            .to_string_lossy()
            .to_string(),
    ))
}

/// Return the note's body. Frontmatter is a matter of the storage format and is not
/// something to show the reader (preview, editor, MCP).
pub fn read_note_by_filename(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<String, CoreError> {
    let content = read_text(&locate_note(base_dir, filename)?.1)?;
    Ok(frontmatter::strip(&content).to_string())
}

/// Return one note's frontmatter as it is.
///
/// `NoteSummary` is the digest for the list (with a body preview, and tags already merged with the
/// body's `#` syntax); this is "the record written in the file" itself, which the metadata edit
/// panel looks at.
pub fn read_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<NoteFrontmatter, CoreError> {
    let content = read_text(&locate_note(base_dir, filename)?.1)?;
    let (fm, _body) = frontmatter::parse::<NoteFrontmatter>(&content)?;
    Ok(fm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::Context;
    use crate::domain::note::{Provenance, create_draft};
    use std::fs;
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
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<NoteFilename, CoreError> {
        create_draft(
            tmp.path(),
            NoteKind::Note,
            body,
            tags,
            &mock_context(),
            Provenance::default(),
        )
    }

    /// A read returns only the body. Returning the frontmatter would flow straight into
    /// the preview or the editor and put metadata on screen.
    #[test]
    fn read_note_by_filename_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let note_filename = draft(&tmp, "# Title\nbody", &[]).unwrap();

        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();

        assert_eq!(content, "# Title\nbody");
    }

    #[test]
    fn test_read_note_by_filename_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let note_filename = NoteFilename::parse("nonexistent.md").unwrap();
        let result = read_note_by_filename(tmp.path(), &note_filename);
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn read_note_meta_returns_time_tags_and_context() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "body", &["sync".to_string()]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();

        assert_eq!(meta.tags, vec!["sync"]);
        assert_eq!(meta.context.unwrap().battery, Some(50));
    }

    #[test]
    fn read_note_meta_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = read_note_meta(tmp.path(), &filename);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
