//! Codex versions: the full body text a person committed as "this far".
//!
//! Not the same as the snapshots in `history.rs`. A snapshot is set aside by the machine
//! before an overwrite from outside, stays on the device, and only the latest 20 are kept.
//! A version is a record a person commits with a message; unless the same history shows
//! on every device it is opened on, it is not an "accumulation", so it lives under `data/`
//! and rides on sync.
//!
//! One version = one Markdown file: the full body plus a small frontmatter (`time` /
//! `message`). It is not kept as a chain of diffs because sync is independent per key and
//! guarantees neither order nor completeness; with full text, a version that arrives can be
//! read and restored on its own. The diff is computed on read. git also holds each version
//! as full text. Diffs are easy to take not because of the storage format but because the
//! two full texts to compare are at hand.
//!
//! The version ID is `YYYYMMDD_HHMMSS-<first 8 hex of the body's SHA-256>`. Time alone
//! collides when two devices commit in the same second. With the content hash attached, a
//! collision needs "the same body in the same second", and that is the same version, so
//! folding it into one is correct.
//!
//! Only a Codex under `data/codex/` can hold versions. A plain note cannot commit one, and
//! leftover versions are not shown as its history.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::{Algorithm, TextDiff};

use crate::error::CoreError;
use crate::note::Revision;
use crate::note::kind::NoteKind;
use crate::note::repository::Notes;
use crate::utils::device::Context;
use crate::utils::frontmatter;
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::paths::codex_dir;
use crate::utils::validated::NoteFilename;

/// The name for "the current draft" in a diff header. It does not overlap with the shape
/// of a version ID (digits, `-` and hex), so a reader cannot mistake it for a version.
pub const DRAFT: &str = "draft";

/// The message of the version committed right before a restore. It is a record written to
/// a file, so it does not vary by language; a display side that knows this string can
/// translate it.
pub const BEFORE_RESTORE: &str = "before restore";

/// One version. `id` is the argument to `read` / `diff` / `restore` as is.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Version {
    pub id: String,
    /// The time it was committed. Read from the frontmatter: the mtime of a version that
    /// arrived through sync is only the time it arrived.
    pub time: DateTime<FixedOffset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Byte count of the body. For showing the change from the previous version in the list.
    pub bytes: u64,
}

/// The "+X B from version N" of the one note that is open.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct VersionStatus {
    pub count: usize,
    /// Whether the latest version and the draft body differ. false when there is no version.
    pub dirty: bool,
    /// The draft's byte count minus the latest version's byte count. 0 when there is no version.
    pub bytes_delta: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct VersionFrontmatter {
    time: DateTime<FixedOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

pub(crate) fn versions_dir(base_dir: &Path, filename: &NoteFilename) -> PathBuf {
    codex_dir(base_dir).join(filename.as_str().trim_end_matches(".md"))
}

fn short_hash(body: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(body.as_bytes());
    let mut hex = String::with_capacity(8);
    for byte in &digest[..4] {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    hex
}

fn version_id(time: DateTime<FixedOffset>, body: &str) -> String {
    format!("{}-{}", time.format("%Y%m%d_%H%M%S"), short_hash(body))
}

/// Only a datetime plus 8 hex digits passes as a version name. An id containing `..` or
/// `/` must not read or write outside the versions directory.
fn version_path(dir: &Path, id: &str) -> Result<PathBuf, CoreError> {
    let well_formed = id.split_once('-').is_some_and(|(stamp, hash)| {
        NaiveDateTime::parse_from_str(stamp, "%Y%m%d_%H%M%S").is_ok()
            && hash.len() == 8
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
    });
    if !well_formed {
        return Err(CoreError::PathTraversal(id.to_string()));
    }
    Ok(dir.join(format!("{id}.md")))
}

/// Only a Codex can hold versions. Readers and writers both go through this first: even
/// if a plain note still has a versions directory (mid-sync, a missed delete), it is
/// leftover that belongs to nobody, not history to show in the list.
fn ensure_codex(base_dir: &Path, filename: &NoteFilename) -> Result<Notes, CoreError> {
    let notes = Notes::new(base_dir.to_path_buf());
    let (kind, _) = notes.locate(filename)?;
    if kind != NoteKind::Codex {
        return Err(CoreError::NotCodex(filename.as_str().to_string()));
    }
    Ok(notes)
}

/// The current draft. Returning a plain note's body would create versions under
/// `data/codex/<stem>/` with no note to own them, and sync would keep distributing them.
fn read_body(base_dir: &Path, filename: &NoteFilename) -> Result<String, CoreError> {
    ensure_codex(base_dir, filename)?.read(filename)
}

fn read_version_file(path: &Path) -> Result<(VersionFrontmatter, String), CoreError> {
    let content = fs::read_to_string(path)?;
    let (fm, body) = frontmatter::parse::<VersionFrontmatter>(&content)?;
    Ok((fm, body.to_string()))
}

/// Commit the current body as a version. If a version with the same body already exists
/// in the same second, return it without rewriting (it is the same version).
pub fn commit_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    message: Option<&str>,
) -> Result<Version, CoreError> {
    let body = read_body(base_dir, filename)?;
    let now = Local::now().fixed_offset();
    let id = version_id(now, &body);
    let dir = versions_dir(base_dir, filename);
    let path = version_path(&dir, &id)?;
    if path.exists() {
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
    // Versions in the same second are ordered deterministically by id (hex). Times are
    // written with each device's offset, so the comparison is of instants, not wall clocks
    versions.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.id.cmp(&a.id)));
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
    if !path.exists() {
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

/// Histogram in 3.x is extremely slow on large input (seconds at 100,000 lines). Myers is
/// fast enough at note sizes, and has a linear-time path even for two unrelated texts.
fn unified_diff(old: &str, new: &str, old_name: &str, new_name: &str) -> String {
    if old == new {
        return String::new();
    }
    TextDiff::configure()
        .algorithm(Algorithm::Myers)
        .diff_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(old_name, new_name)
        .to_string()
}

/// Make a version's body the draft. The current draft is committed first as a
/// [`BEFORE_RESTORE`] version, so the restore itself can be undone. The write takes the
/// same path as `update_note`: a stale `expected` gives [`CoreError::Stale`] and writes
/// nothing (and commits nothing).
pub fn restore_note_version(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
    context: &Context,
    expected: Option<&Revision>,
) -> Result<Revision, CoreError> {
    let restored = read_note_version(base_dir, filename, id)?;
    let (_, path) = Notes::new(base_dir.to_path_buf()).locate(filename)?;
    if let Some(expected) = expected {
        let current = Revision::of(&read_body(base_dir, filename)?);
        if current != *expected {
            return Err(CoreError::Stale(filename.as_str().to_string()));
        }
    }
    commit_note_version(base_dir, filename, Some(BEFORE_RESTORE))?;
    Notes::update(&path, &restored, context, expected)
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
    if !path.exists() {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }
    fs::remove_file(path)?;
    Ok(())
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
            // A body never exceeds i64. If it did, that is another problem, not a delta
            i64::try_from(body.len()).unwrap_or(i64::MAX)
                - i64::try_from(latest.bytes).unwrap_or(i64::MAX),
        ),
        None => (false, 0),
    };
    Ok(VersionStatus {
        count: versions.len(),
        dirty,
        bytes_delta,
    })
}

/// The "version N" and "has it moved" for a list row. Not one version file is opened:
/// the tail of a version ID is the first 8 hex of the body's SHA-256, so comparing the
/// tail of the newest name with the draft's fingerprint is enough.
///
/// "Newest" is decided by filename (the wall clock of the device that committed).
/// [`list_note_versions`] orders by the instant in the frontmatter, so the two can
/// disagree only when two devices in different time zones commit at close times. That
/// is not worth paying for a row mark: once opened, [`note_version_status`] reads the
/// body and answers exactly.
///
/// `dir` is the note's path minus `.md` (the same as [`versions_dir`]).
/// The list scan arrives here without a `NoteFilename`.
pub(crate) fn list_status(dir: &Path, body: &str) -> Result<(usize, bool), CoreError> {
    // list_md_files is in descending name order. The first is the newest
    let entries = list_md_files(dir)?;
    let dirty = entries.first().is_some_and(|newest| {
        let name = newest.file_name();
        let stem = Path::new(&name).file_stem().and_then(|s| s.to_str());
        stem.and_then(|s| s.rsplit_once('-'))
            .is_some_and(|(_, hash)| hash != short_hash(body))
    });
    Ok((entries.len(), dirty))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frontmatter::Provenance;
    use crate::{create_draft_codex, create_draft_note, read_note_by_filename, update_note};
    use chrono::TimeZone;
    use tempfile::TempDir;

    /// The note to commit versions on. Only a Codex can commit, so the test default is a Codex.
    fn note(base: &Path, body: &str) -> (PathBuf, NoteFilename) {
        let path = create_draft_codex(base, body, &[], &Context::default(), Provenance::default())
            .unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();
        (path, filename)
    }

    /// A plain note cannot commit a version. It is only refused; no versions directory is created.
    #[test]
    fn a_plain_note_cannot_be_given_versions() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "ただのノート",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();

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

    /// The same body in a different second is another version; a different body in the
    /// same second is another version too.
    #[test]
    fn the_id_is_the_second_and_the_body_together() {
        let t1 = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 9, 17, 14, 3, 0)
            .unwrap();
        let t2 = t1 + chrono::Duration::seconds(1);

        assert_ne!(version_id(t1, "a"), version_id(t2, "a"));
        assert_ne!(version_id(t1, "a"), version_id(t1, "b"));
        assert_eq!(version_id(t1, "a"), version_id(t1, "a"));
        assert!(version_id(t1, "a").starts_with("20260917_140300-"));
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

    /// The version count and "has it moved" shown on a list row. Version bodies are not
    /// read; only the hash in the filename is compared.
    #[test]
    fn the_list_carries_the_version_count_and_whether_the_draft_moved() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");
        let row = |base: &Path| {
            crate::list_notes(base)
                .unwrap()
                .into_iter()
                .find(|s| s.filename == filename.as_str())
                .unwrap()
        };

        let none = row(tmp.path());
        assert_eq!(none.version_count, Some(0));
        assert_eq!(none.dirty, Some(false));

        commit_note_version(tmp.path(), &filename, None).unwrap();
        let clean = row(tmp.path());
        assert_eq!(clean.version_count, Some(1));
        assert_eq!(clean.dirty, Some(false));

        update_note(&path, "two", &Context::default(), None).unwrap();
        let moved = row(tmp.path());
        assert_eq!(moved.version_count, Some(1));
        assert_eq!(moved.dirty, Some(true));
    }

    /// A plain note's row has no version fields at all.
    #[test]
    fn a_plain_note_row_has_no_version_fields() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(
            tmp.path(),
            "plain",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();

        let rows = crate::list_notes(tmp.path()).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].version_count, None);
        assert_eq!(rows[0].dirty, None);
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
