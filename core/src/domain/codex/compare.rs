//! Comparing a Codex with its versions: the history tab is compare mode itself. The
//! versions, a version's body, the diff between two of them or against the draft, and
//! "+X B from version N".

use std::path::Path;

use crate::domain::codex::draft::{ensure_codex, read_body};
use crate::domain::codex::version::{
    DRAFT, Version, VersionFrontmatter, VersionStatus, bytes_delta, order, version_path,
    versions_dir,
};
use crate::domain::note::NoteFilename;
use crate::services::files::{exists, list_md_files, read_text};
use crate::utils::diff::unified_diff;
use crate::utils::error::CoreError;
use crate::utils::frontmatter;

pub(super) fn read_version_file(path: &Path) -> Result<(VersionFrontmatter, String), CoreError> {
    let content = read_text(path)?;
    let (fm, body) = frontmatter::parse::<VersionFrontmatter>(&content)?;
    Ok((fm, body.to_string()))
}

/// The versions, newest first. A version that cannot be read (broken frontmatter) is only
/// dropped from the list; the other versions stay readable.
pub fn list_note_versions(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Vec<Version>, CoreError> {
    ensure_codex(base_dir, filename)?;
    let dir = versions_dir(base_dir, filename);
    let mut versions: Vec<Version> = list_md_files(&dir)?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = Path::new(&name).file_stem()?.to_str()?.to_string();
            let (fm, body) = read_version_file(&entry.path()).ok()?;
            Some(Version {
                id,
                time: fm.time,
                message: fm.message,
                bytes: body.len() as u64,
            })
        })
        .collect();
    order(&mut versions);
    Ok(versions)
}

/// The body of a version. The frontmatter is not attached: as with `read_note`, it is not
/// something the reader is shown.
pub fn read_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
) -> Result<String, CoreError> {
    ensure_codex(base_dir, filename)?;
    let path = version_path(&versions_dir(base_dir, filename), id)?;
    if !exists(&path) {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }
    Ok(read_version_file(&path)?.1)
}

/// The unified diff from version `from` to `to`. When `to` is `None`, the target is the
/// draft (the current body). When they are equal, the result is an empty string with no header.
pub fn diff_note_versions(
    base_dir: &Path,
    filename: &NoteFilename,
    from: &str,
    to: Option<&str>,
) -> Result<String, CoreError> {
    let old = read_note_version(base_dir, filename, from)?;
    let new = match to {
        Some(id) => read_note_version(base_dir, filename, id)?,
        None => read_body(base_dir, filename)?,
    };
    Ok(unified_diff(&old, &new, from, to.unwrap_or(DRAFT)))
}

/// The number of versions, and how far the draft has moved from the latest one.
pub fn note_version_status(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<VersionStatus, CoreError> {
    // The body is read even without versions: a plain note gets `NotCodex`
    let body = read_body(base_dir, filename)?;
    let versions = list_note_versions(base_dir, filename)?;
    let (dirty, bytes_delta) = match versions.first() {
        Some(latest) => (
            read_note_version(base_dir, filename, &latest.id)? != body,
            bytes_delta(body.len(), latest.bytes),
        ),
        None => (false, 0),
    };
    Ok(VersionStatus {
        count: versions.len(),
        dirty,
        bytes_delta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::codex::commit_note_version;
    use crate::domain::device::Context;
    use crate::domain::note::{Provenance, create_draft_codex, update_note};
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
    fn a_note_without_versions_has_none() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        assert!(
            list_note_versions(tmp.path(), &filename)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            note_version_status(tmp.path(), &filename).unwrap(),
            VersionStatus {
                count: 0,
                dirty: false,
                bytes_delta: 0
            }
        );
    }

    #[test]
    fn a_changed_body_makes_a_second_version_listed_newest_first() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        let first = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();

        let second = commit_note_version(tmp.path(), &filename, None).unwrap();

        let ids: Vec<String> = list_note_versions(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|v| v.id)
            .collect();
        assert_eq!(ids, vec![second.id, first.id.clone()]);
        assert_eq!(
            read_note_version(tmp.path(), &filename, &first.id).unwrap(),
            "one"
        );
    }

    #[test]
    fn diff_against_the_draft_is_a_unified_diff_and_empty_when_equal() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "a\nb\nc\n");
        let version = commit_note_version(tmp.path(), &filename, None).unwrap();

        assert_eq!(
            diff_note_versions(tmp.path(), &filename, &version.id, None).unwrap(),
            "",
            "同じならヘッダも出さない"
        );

        update_note(&path, "a\nB\nc\nd\n", &Context::default(), None).unwrap();
        let diff = diff_note_versions(tmp.path(), &filename, &version.id, None).unwrap();

        assert_eq!(
            diff,
            format!(
                "--- {}\n+++ draft\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n",
                version.id
            )
        );
    }

    #[test]
    fn diff_between_two_versions_names_both() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "x\n");
        let old = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "y\n", &Context::default(), None).unwrap();
        let new = commit_note_version(tmp.path(), &filename, None).unwrap();

        let diff = diff_note_versions(tmp.path(), &filename, &old.id, Some(&new.id)).unwrap();

        assert!(
            diff.starts_with(&format!("--- {}\n+++ {}\n", old.id, new.id)),
            "{diff}"
        );
        assert!(diff.contains("-x\n+y\n"), "{diff}");
    }

    #[test]
    fn editing_after_a_version_makes_the_draft_dirty() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();

        assert_eq!(
            note_version_status(tmp.path(), &filename).unwrap(),
            VersionStatus {
                count: 1,
                dirty: true,
                bytes_delta: 0
            }
        );
    }

    #[test]
    fn an_id_that_is_not_a_version_name_cannot_leave_the_directory() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        for id in [
            "../../etc/passwd",
            "20260917_140300",
            "20260917_140300-zz",
            "",
        ] {
            let err = read_note_version(tmp.path(), &filename, id).unwrap_err();
            assert!(matches!(err, CoreError::PathTraversal(_)), "{id}: {err}");
        }
        let err = read_note_version(tmp.path(), &filename, "20260917_140300-0123abcd").unwrap_err();
        assert!(matches!(err, CoreError::NotFound(_)), "{err}");
    }

    /// The X in "+X B from version N". The byte difference between the latest version and
    /// the draft.
    #[test]
    fn the_status_measures_the_draft_against_the_latest_version() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        assert_eq!(
            note_version_status(tmp.path(), &filename)
                .unwrap()
                .bytes_delta,
            0,
            "版が無ければ差も無い"
        );

        commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "one and more", &Context::default(), None).unwrap();

        let status = note_version_status(tmp.path(), &filename).unwrap();
        assert_eq!(status.bytes_delta, 9, "12 バイトから 3 バイトを引いた差");

        update_note(&path, "o", &Context::default(), None).unwrap();
        assert_eq!(
            note_version_status(tmp.path(), &filename)
                .unwrap()
                .bytes_delta,
            -2
        );
    }
}
