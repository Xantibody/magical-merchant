//! The draft: a Codex's current body, the one every version is committed from and
//! compared against.

use std::path::Path;

use crate::domain::note::{NoteFilename, NoteKind, locate_note, read_note_by_filename};
use crate::utils::error::CoreError;

/// Only a Codex can hold versions. Readers and writers both go through this first: even
/// if a plain note still has a versions directory (mid-sync, a missed delete), it is
/// leftover that belongs to nobody, not history to show in the list.
pub(super) fn ensure_codex(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    let (kind, _) = locate_note(base_dir, filename)?;
    if kind != NoteKind::Codex {
        return Err(CoreError::NotCodex(filename.as_str().to_string()));
    }
    Ok(())
}

/// The current draft. Returning a plain note's body would create versions under
/// `data/codex/<stem>/` with no note to own them, and sync would keep distributing them.
pub(super) fn read_body(base_dir: &Path, filename: &NoteFilename) -> Result<String, CoreError> {
    ensure_codex(base_dir, filename)?;
    read_note_by_filename(base_dir, filename)
}

#[cfg(test)]
mod tests {
    use crate::domain::codex::version::versions_dir;
    use crate::domain::codex::{
        commit_note_version, list_note_versions, note_version_status, read_note_version,
    };
    use crate::domain::device::Context;
    use crate::domain::note::{NoteKind, Provenance, create_draft};
    use crate::utils::error::CoreError;
    use std::fs;
    use tempfile::TempDir;

    /// A plain note cannot commit a version. It is only refused; no versions directory is created.
    #[test]
    fn a_plain_note_cannot_be_given_versions() {
        let tmp = TempDir::new().unwrap();
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            "ただのノート",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();

        let result = commit_note_version(tmp.path(), &filename, Some("試し"));

        assert!(matches!(result, Err(CoreError::NotCodex(_))));
        assert!(!versions_dir(tmp.path(), &filename).exists());
        assert!(matches!(
            note_version_status(tmp.path(), &filename),
            Err(CoreError::NotCodex(_))
        ));

        // Even with leftover versions, they are not shown as a plain note's history
        let orphan = versions_dir(tmp.path(), &filename);
        fs::create_dir_all(&orphan).unwrap();
        fs::write(
            orphan.join("20260503_153900-00000000.md"),
            "---\ntime: 2026-05-03T15:39:00+09:00\n---\n残骸",
        )
        .unwrap();
        assert!(matches!(
            list_note_versions(tmp.path(), &filename),
            Err(CoreError::NotCodex(_))
        ));
        assert!(matches!(
            read_note_version(tmp.path(), &filename, "20260503_153900-00000000"),
            Err(CoreError::NotCodex(_))
        ));
    }
}
