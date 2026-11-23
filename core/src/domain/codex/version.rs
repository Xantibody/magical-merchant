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

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::note::kind::codex_dir;
use crate::domain::note::{NoteFilename, Revision};
use crate::utils::clock::{Stamp, WallClock};
use crate::utils::error::CoreError;

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
    pub time: Stamp,
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
pub(crate) struct VersionFrontmatter {
    pub(crate) time: Stamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) message: Option<String>,
}

pub(crate) fn versions_dir(base_dir: &Path, filename: &NoteFilename) -> PathBuf {
    codex_dir(base_dir).join(filename.as_str().trim_end_matches(".md"))
}

pub(crate) fn version_id(time: Stamp, body: &str) -> String {
    format!("{}-{}", time.id_stem(), Revision::of(body).short())
}

/// Only a datetime plus 8 hex digits passes as a version name. An id containing `..` or
/// `/` must not read or write outside the versions directory.
pub(crate) fn version_path(dir: &Path, id: &str) -> Result<PathBuf, CoreError> {
    let well_formed = id.split_once('-').is_some_and(|(stamp, hash)| {
        WallClock::parse_id_stem(stamp).is_ok()
            && hash.len() == 8
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
    });
    if !well_formed {
        return Err(CoreError::PathTraversal(id.to_string()));
    }
    Ok(dir.join(format!("{id}.md")))
}

/// Orders versions newest first by the instant each was committed.
pub(crate) fn order(versions: &mut [Version]) {
    // Versions in the same second are ordered deterministically by id (hex). Times are
    // written with each device's offset, so the comparison is of instants, not wall clocks
    versions.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.id.cmp(&a.id)));
}

/// The draft's byte count minus the latest version's: the X in "+X B from version N".
pub(crate) fn bytes_delta(draft_len: usize, latest_bytes: u64) -> i64 {
    // A body never exceeds i64. If it did, that is another problem, not a delta
    i64::try_from(draft_len).unwrap_or(i64::MAX) - i64::try_from(latest_bytes).unwrap_or(i64::MAX)
}

/// The "version N" and "has it moved" for a list row, from the names of the version
/// files and the draft body. Not one version file is opened: the tail of a version ID is
/// the first 8 hex of the body's SHA-256, so comparing the tail of the newest name with
/// the draft's fingerprint is enough.
///
/// "Newest" is the greatest filename (the wall clock of the device that committed).
/// `list_note_versions` orders by the instant in the frontmatter, so the two can
/// disagree only when two devices in different time zones commit at close times. That
/// is not worth paying for a row mark: once opened, `note_version_status` reads the
/// body and answers exactly.
pub(crate) fn version_mark<N: AsRef<OsStr>>(names: &[N], body: &str) -> (usize, bool) {
    let dirty = names.iter().map(AsRef::as_ref).max().is_some_and(|newest| {
        let stem = Path::new(newest).file_stem().and_then(|s| s.to_str());
        stem.and_then(|s| s.rsplit_once('-'))
            .is_some_and(|(_, hash)| hash != Revision::of(body).short())
    });
    (names.len(), dirty)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frontmatter;

    /// The same body in a different second is another version; a different body in the
    /// same second is another version too.
    #[test]
    fn the_id_is_the_second_and_the_body_together() {
        let t1 = Stamp::new(2026, 9, 17, 14, 3, 0, 9 * 3600).unwrap();
        let t2 = t1.plus_seconds(1);

        assert_ne!(version_id(t1, "a"), version_id(t2, "a"));
        assert_ne!(version_id(t1, "a"), version_id(t1, "b"));
        assert_eq!(version_id(t1, "a"), version_id(t1, "a"));
        assert!(version_id(t1, "a").starts_with("20260917_140300-"));
    }

    /// The tail of a version id is the first 8 hex of the body's SHA-256. Version files
    /// already synced to every device carry this name, so it must not drift.
    #[test]
    fn a_version_id_ends_with_the_body_sha256_prefix() {
        let time = Stamp::new(2026, 9, 17, 14, 3, 0, 9 * 3600).unwrap();

        assert_eq!(version_id(time, "a"), "20260917_140300-ca978112");
    }

    /// A version file syncs as it is written, so its `time:` bytes are its content hash
    /// too. A millisecond fraction keeps all three digits.
    #[test]
    fn a_version_file_is_byte_exact() {
        let time: Stamp = "2026-09-17T14:03:00.250+09:00".parse().unwrap();
        let fm = VersionFrontmatter {
            time,
            message: Some("m".to_string()),
        };

        assert_eq!(
            frontmatter::render(&fm, "body").unwrap(),
            "---\ntime: 2026-09-17T14:03:00.250+09:00\nmessage: m\n---\nbody"
        );
    }

    /// The stamp in a version id has to be a real date and time, not only 15 digits in shape.
    #[test]
    fn an_impossible_date_is_not_a_version_id() {
        let dir = Path::new("versions");
        for (id, accepted) in [
            ("20260917_140300-0123abcd", true),
            ("20261317_140300-0123abcd", false),
            ("20260230_000000-0123abcd", false),
            ("20260917_240000-0123abcd", false),
            // A leap second is a time chrono can hold, so it passes
            ("20260917_235960-0123abcd", true),
        ] {
            assert_eq!(version_path(dir, id).is_ok(), accepted, "{id}");
        }
    }

    #[test]
    fn a_codex_without_versions_has_none_and_has_not_moved() {
        let none: [&str; 0] = [];

        assert_eq!(version_mark(&none, "a"), (0, false));
    }

    /// "a" hashes to `ca978112`, so a newest version with that tail is the draft itself.
    #[test]
    fn a_draft_matching_the_newest_tail_has_not_moved() {
        let names = ["20260917_140000-00000000.md", "20260917_140300-ca978112.md"];

        assert_eq!(version_mark(&names, "a"), (2, false));
    }

    #[test]
    fn a_draft_differing_from_the_newest_tail_has_moved() {
        let names = ["20260917_140000-ca978112.md", "20260917_140300-00000000.md"];

        assert_eq!(version_mark(&names, "a"), (2, true));
    }

    /// The names come in whatever order the directory gives; the greatest one is the newest.
    #[test]
    fn the_newest_name_is_found_in_any_order() {
        let newest_last = ["20260917_140000-00000000.md", "20260917_140300-ca978112.md"];
        let newest_first = ["20260917_140300-ca978112.md", "20260917_140000-00000000.md"];

        assert_eq!(version_mark(&newest_last, "a"), (2, false));
        assert_eq!(version_mark(&newest_first, "a"), (2, false));
    }

    fn version(id: &str, time: &str) -> Version {
        Version {
            id: id.to_string(),
            time: time.parse().unwrap(),
            message: None,
            bytes: 0,
        }
    }

    #[test]
    fn versions_are_ordered_newest_instant_first() {
        let mut versions = [
            version("20260917_140000-00000000", "2026-09-17T14:00:00+09:00"),
            // A minute later, committed from another offset: its wall clock reads earlier
            version("20260917_050100-00000000", "2026-09-17T05:01:00+00:00"),
        ];

        order(&mut versions);

        let ids: Vec<&str> = versions.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["20260917_050100-00000000", "20260917_140000-00000000"]
        );
    }

    /// Two versions in the same second keep one order on every device: the id descending.
    #[test]
    fn versions_in_the_same_second_are_ordered_by_id_descending() {
        let mut versions = [
            version("20260917_140300-0123abcd", "2026-09-17T14:03:00+09:00"),
            version("20260917_140300-ffff0000", "2026-09-17T14:03:00+09:00"),
            version("20260917_140300-80000000", "2026-09-17T14:03:00+09:00"),
        ];

        order(&mut versions);

        let ids: Vec<&str> = versions.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "20260917_140300-ffff0000",
                "20260917_140300-80000000",
                "20260917_140300-0123abcd",
            ]
        );
    }

    #[test]
    fn the_byte_delta_is_the_draft_minus_the_latest_version() {
        assert_eq!(bytes_delta(12, 3), 9);
        assert_eq!(bytes_delta(1, 3), -2);
        assert_eq!(bytes_delta(3, 3), 0);
    }
}
