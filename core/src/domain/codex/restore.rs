//! Restoring a version: making its body the draft again.

use std::path::Path;

use crate::domain::codex::commit::commit_note_version;
use crate::domain::codex::compare::read_note_version;
use crate::domain::codex::draft::read_body;
use crate::domain::codex::version::BEFORE_RESTORE;
use crate::domain::device::Context;
use crate::domain::note::{NoteFilename, Revision, locate_note, update_note};
use crate::error::CoreError;

/// Make a version's body the draft.
///
/// The current draft is committed first as a [`BEFORE_RESTORE`] version, so the restore itself can
/// be undone. The write takes the same path as `update_note`: a stale `expected` gives
/// [`CoreError::Stale`] and writes nothing (and commits nothing).
pub fn restore_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
    context: &Context,
    expected: Option<&Revision>,
) -> Result<Revision, CoreError> {
    let restored = read_note_version(base_dir, filename, id)?;
    let (_, path) = locate_note(base_dir, filename)?;
    if let Some(expected) = expected {
        let current = Revision::of(&read_body(base_dir, filename)?);
        if current != *expected {
            return Err(CoreError::Stale(filename.as_str().to_string()));
        }
    }
    commit_note_version(base_dir, filename, Some(BEFORE_RESTORE))?;
    update_note(&path, &restored, context, expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::codex::list_note_versions;
    use crate::domain::note::{Provenance, create_draft_codex, read_note_by_filename};
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// The note to commit versions on. Only a Codex can commit, so the test default is a Codex.
    fn note(base: &Path, body: &str) -> (PathBuf, NoteFilename) {
        let path = create_draft_codex(base, body, &[], &Context::default(), Provenance::default())
            .unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();
        (path, filename)
    }

    #[test]
    fn restoring_brings_the_version_back_and_keeps_the_draft_as_a_version() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let version = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();
        let read = Revision::of("after");

        let revision = restore_note_version(
            tmp.path(),
            &filename,
            &version.id,
            &Context::default(),
            Some(&read),
        )
        .unwrap();

        assert_eq!(revision, Revision::of("before"));
        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
        let listed = list_note_versions(tmp.path(), &filename).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].message.as_deref(), Some(BEFORE_RESTORE));
        assert_eq!(
            read_note_version(tmp.path(), &filename, &listed[0].id).unwrap(),
            "after"
        );
    }

    #[test]
    fn a_stale_restore_writes_nothing_and_commits_nothing() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let version = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();
        let stale = Revision::of("something else");

        let err = restore_note_version(
            tmp.path(),
            &filename,
            &version.id,
            &Context::default(),
            Some(&stale),
        )
        .unwrap_err();

        assert!(matches!(err, CoreError::Stale(_)), "{err}");
        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "after"
        );
        assert_eq!(list_note_versions(tmp.path(), &filename).unwrap().len(), 1);
    }
}
