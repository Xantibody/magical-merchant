//! Opening a note: finding it by ID, and reading its body or its record.

use std::path::{Path, PathBuf};

use crate::domain::note::{NoteFilename, NoteFrontmatter, NoteKind, Revision};
use crate::services::files::{read_text, resolve_existing};
use crate::utils::error::CoreError;
use crate::utils::frontmatter;

/// Look up a note's kind and actual location from its ID.
///
/// Every operation that takes an ID finds the file here, [`crate::update_note`] among them:
/// hardcoding `notes/` would make a note turned into a Codex "missing", or recreate a
/// plain note beside it.
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

/// A note as one read of its file gives it.
#[derive(Debug, Clone)]
pub struct OpenedNote {
    /// The directory it was found in.
    pub kind: NoteKind,
    /// The body, without the frontmatter.
    pub body: String,
    /// The fingerprint of `body`, to pass back when writing it.
    pub revision: Revision,
    /// The record in the frontmatter. `None` when it cannot be read: frontmatter that
    /// does not parse is no reason to hide the body as well.
    pub meta: Option<NoteFrontmatter>,
}

/// Open a note by its ID: where it lives, its body with the revision to write it back
/// with, and its record, from one read of the file.
///
/// Fails as [`read_note_by_filename`] does: `NotFound` when no directory holds the ID,
/// `Io` (`InvalidData`) when the bytes are not text.
pub fn open_note(base_dir: &Path, filename: &NoteFilename) -> Result<OpenedNote, CoreError> {
    let (kind, path) = locate_note(base_dir, filename)?;
    let content = read_text(&path)?;
    let body = frontmatter::strip(&content).to_string();
    let meta = frontmatter::parse::<NoteFrontmatter>(&content)
        .ok()
        .map(|(fm, _)| fm);
    Ok(OpenedNote {
        kind,
        revision: Revision::of(&body),
        body,
        meta,
    })
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

    /// One read gives what the app, the CLI and the MCP each read separately before: the
    /// kind, the body and its revision, and the record.
    #[test]
    fn opening_a_note_gives_its_kind_body_revision_and_record() {
        let tmp = TempDir::new().unwrap();
        let filename = create_draft(
            tmp.path(),
            NoteKind::Codex,
            "# Title\nbody",
            &["sync".to_string()],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap();

        let opened = open_note(tmp.path(), &filename).unwrap();

        assert_eq!(opened.kind, NoteKind::Codex);
        assert_eq!(opened.body, "# Title\nbody");
        assert_eq!(opened.revision, Revision::of("# Title\nbody"));
        assert_eq!(opened.meta.unwrap().tags, vec!["sync"]);
    }

    #[test]
    fn a_note_with_a_broken_record_opens_with_its_body_and_no_record() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/notes");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("20260101_120000.md"),
            "---\ntime: [broken\n---\nbody",
        )
        .unwrap();
        let filename = NoteFilename::parse("20260101_120000.md").unwrap();

        let opened = open_note(tmp.path(), &filename).unwrap();

        assert_eq!(opened.kind, NoteKind::Note);
        assert_eq!(opened.body, "body");
        assert!(opened.meta.is_none());
    }

    #[test]
    fn opening_fails_as_reading_the_body_does() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/notes");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("20260101_120000.md"), b"\xff\xfe").unwrap();
        let garbled = NoteFilename::parse("20260101_120000.md").unwrap();
        let missing = NoteFilename::parse("20260101_130000.md").unwrap();

        let not_text = |e: &CoreError| matches!(e, CoreError::Io(io) if io.kind() == std::io::ErrorKind::InvalidData);
        assert!(open_note(tmp.path(), &garbled).is_err_and(|e| not_text(&e)));
        assert!(read_note_by_filename(tmp.path(), &garbled).is_err_and(|e| not_text(&e)));
        assert!(matches!(
            open_note(tmp.path(), &missing),
            Err(CoreError::NotFound(_))
        ));
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
