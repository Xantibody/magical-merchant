//! Committing a version of a Codex, and the undo right after it.

use std::path::Path;

use crate::domain::codex::compare::read_version_file;
use crate::domain::codex::draft::{ensure_codex, read_body};
use crate::domain::codex::version::{
    Version, VersionFrontmatter, version_id, version_path, versions_dir,
};
use crate::domain::note::NoteFilename;
use crate::error::CoreError;
use crate::services::files::{ensure_dir, exists, remove, write_atomic};
use crate::utils::clock::Stamp;
use crate::utils::frontmatter;

/// Commit the current body as a version. If a version with the same body already exists
/// in the same second, return it without rewriting (it is the same version).
pub fn commit_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    message: Option<&str>,
) -> Result<Version, CoreError> {
    let body = read_body(base_dir, filename)?;
    let now = Stamp::now_local();
    let id = version_id(now, &body);
    let dir = versions_dir(base_dir, filename);
    let path = version_path(&dir, &id)?;
    if exists(&path) {
        let (fm, body) = read_version_file(&path)?;
        return Ok(Version {
            id,
            time: fm.time,
            message: fm.message,
            bytes: body.len() as u64,
        });
    }
    let fm = VersionFrontmatter {
        time: now,
        message: message.map(str::to_string),
    };
    ensure_dir(&path)?;
    write_atomic(&path, frontmatter::render(&fm, &body)?)?;
    Ok(Version {
        id,
        time: now,
        message: fm.message,
        bytes: body.len() as u64,
    })
}

/// Delete one version. It exists for the "undo" right after a commit: a version is a mark
/// a person makes, so no other path (MCP, CLI, sync cleanup) calls this.
/// The body is not touched.
pub fn delete_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
) -> Result<(), CoreError> {
    ensure_codex(base_dir, filename)?;
    let path = version_path(&versions_dir(base_dir, filename), id)?;
    if !exists(&path) {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }
    remove(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::codex::{
        VersionStatus, list_note_versions, note_version_status, read_note_version,
    };
    use crate::domain::note::{Provenance, create_draft_codex, read_note_by_filename, update_note};
    use crate::utils::device::Context;
    use std::fs;
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
    fn the_first_version_keeps_the_body_the_message_and_the_time() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "# 題\n\n本文");

        let version = commit_note_version(tmp.path(), &filename, Some("最初の版")).unwrap();

        let listed = list_note_versions(tmp.path(), &filename).unwrap();
        assert_eq!(listed, vec![version.clone()]);
        assert_eq!(version.message.as_deref(), Some("最初の版"));
        assert_eq!(version.bytes, "# 題\n\n本文".len() as u64);
        let body = read_note_version(tmp.path(), &filename, &version.id).unwrap();
        assert_eq!(body, "# 題\n\n本文", "frontmatter は付いてこない");
        assert_eq!(
            note_version_status(tmp.path(), &filename).unwrap(),
            VersionStatus {
                count: 1,
                dirty: false,
                bytes_delta: 0
            }
        );
    }

    /// A version lives under `data/`, under that Codex's stem. It shows up in the sync scan.
    #[test]
    fn a_version_is_a_markdown_file_under_the_synced_codex_tree() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        let version = commit_note_version(tmp.path(), &filename, None).unwrap();

        let stem = filename.as_str().trim_end_matches(".md");
        let path = tmp
            .path()
            .join("data")
            .join("codex")
            .join(stem)
            .join(format!("{}.md", version.id));
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("---\ntime: "), "{content}");
        assert!(content.ends_with("---\nbody"), "{content}");
        assert!(!content.contains("message"), "無い message は書かない");

        let keys: Vec<String> = crate::sync::scan::scan_local_files(tmp.path())
            .unwrap()
            .into_iter()
            .map(|f| f.key)
            .collect();
        assert!(
            keys.contains(&format!("codex/{stem}/{}.md", version.id)),
            "{keys:?}"
        );
    }

    #[test]
    fn the_same_body_in_the_same_second_is_the_same_version() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        let first = commit_note_version(tmp.path(), &filename, Some("a")).unwrap();
        let again = commit_note_version(tmp.path(), &filename, Some("b")).unwrap();

        assert_eq!(first, again, "書き直さないので message も最初のまま");
        assert_eq!(list_note_versions(tmp.path(), &filename).unwrap().len(), 1);
    }

    /// The "undo" right after a commit. Only the version file is deleted; the body is not touched.
    #[test]
    fn deleting_a_version_removes_only_that_version() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        let first = commit_note_version(tmp.path(), &filename, None).unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();
        let second = commit_note_version(tmp.path(), &filename, None).unwrap();

        delete_note_version(tmp.path(), &filename, &second.id).unwrap();

        let ids: Vec<String> = list_note_versions(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|v| v.id)
            .collect();
        assert_eq!(ids, vec![first.id]);
        assert_eq!(read_note_by_filename(tmp.path(), &filename).unwrap(), "two");
        // There is no second time
        assert!(matches!(
            delete_note_version(tmp.path(), &filename, &second.id),
            Err(CoreError::NotFound(_))
        ));
        // A name of the wrong shape does not reach outside the directory
        assert!(matches!(
            delete_note_version(tmp.path(), &filename, "../../x"),
            Err(CoreError::PathTraversal(_))
        ));
    }
}
