//! The note write path shared by the MCP and the CLI.
//!
//! A rewrite from outside happens where the user is not looking. So before writing, a copy
//! is taken (there is a way back), the revision from the read is passed along (another
//! writer's edit is not erased), and the frontmatter is left to core (the rules are not
//! broken). The procedure lives in this one place so that the same guards hold from every
//! entry point.

use std::path::Path;

use chrono::{DateTime, FixedOffset};

use magical_merchant_core::utils::device::Context;
use magical_merchant_core::{CoreError, NoteFilename, Provenance, Revision, Snapshot};

/// The device recorded at write time.
///
/// It is measured by the same core probe as the app, so battery, network and OS version all
/// line up here.
///
/// Only the coordinates are left out. Locating takes a permission and a wait of several
/// seconds, which is too expensive for a CLI that writes one line and exits. Reusing the
/// coordinates the app measured last is an option, but then a record written on a day the
/// app was never opened carries the previous place. What is unknown is left unknown.
// AIDEV-NOTE: working it out from Wi-Fi is closed off too. SSID/BSSID need the same
// permission as locating, and come back redacted
pub(crate) fn context() -> Context {
    magical_merchant_core::utils::device::probe()
}

/// The body that was read, and the revision to pass along when writing it back.
#[derive(Debug)]
pub(crate) struct Read {
    pub(crate) body: String,
    pub(crate) revision: Revision,
}

#[derive(Debug)]
pub(crate) struct Written {
    /// A copy of the whole file as it stood just before the rewrite.
    pub(crate) snapshot: Snapshot,
    /// The revision of the body that was written. The `expected` for a following write.
    pub(crate) revision: Revision,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum WriteError {
    #[error("body is empty; delete is not offered here")]
    Empty,
    #[error("note not found: {0}")]
    NotFound(NoteFilename),
    /// Between the read and the write, another writer (app, MCP or CLI) changed the body.
    #[error("{0} changed since it was read; re-read it and edit again")]
    Stale(NoteFilename),
    #[error("{0}")]
    Other(#[from] CoreError),
}

/// Creates one note. What comes back is the filename given to it, the note's ID itself.
///
/// An empty body creates nothing (`None`). This keeps an empty from a mistyped key or a
/// closed editor from staying as a record with no way to delete it. The caller names the
/// origin: the CLI and the MCP go through the same path, and the shared helper does not
/// name them both at once.
pub(crate) fn create(
    data_dir: &Path,
    body: &str,
    tags: &[String],
    provenance: Provenance<'_>,
) -> Result<Option<NoteFilename>, CoreError> {
    if body.trim().is_empty() {
        return Ok(None);
    }
    named(&magical_merchant_core::create_draft_note(
        data_dir,
        body,
        tags,
        &context(),
        provenance,
    )?)
}

/// The variant that takes the time it was written. For a record that came from outside,
/// that time becomes the ID. Like `create`, it creates nothing from an empty body and
/// writes `context` from this device as it is now.
pub(crate) fn create_at(
    data_dir: &Path,
    time: DateTime<FixedOffset>,
    body: &str,
    tags: &[String],
    provenance: Provenance<'_>,
) -> Result<Option<NoteFilename>, CoreError> {
    if body.trim().is_empty() {
        return Ok(None);
    }
    named(&magical_merchant_core::create_note_at(
        data_dir,
        time,
        body,
        tags,
        &context(),
        provenance,
    )?)
}

/// Reads the written file's path back as an ID. The caller only wants the name.
fn named(path: &Path) -> Result<Option<NoteFilename>, CoreError> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::NotFound(path.display().to_string()))?;
    NoteFilename::parse(name).map(Some)
}

pub(crate) fn read(data_dir: &Path, filename: &NoteFilename) -> Result<Read, CoreError> {
    let body = magical_merchant_core::read_note_by_filename(data_dir, filename)?;
    let revision = Revision::of(&body);
    Ok(Read { body, revision })
}

/// Replaces the body. The order is fixed: copy, then revision check, then write.
///
/// A `None` `expected` means no check. It is kept for an MCP client that writes without
/// reading, but a client that read should pass it.
pub(crate) fn overwrite(
    data_dir: &Path,
    filename: &NoteFilename,
    body: &str,
    expected: Option<&Revision>,
) -> Result<Written, WriteError> {
    if body.trim().is_empty() {
        return Err(WriteError::Empty);
    }
    // Check before taking the copy too. With only core's check, a write that will be
    // refused adds one more copy of the other writer's version. core stays the last line
    if let Some(expected) = expected {
        let current = read(data_dir, filename)?;
        if current.revision != *expected {
            return Err(WriteError::Stale(filename.clone()));
        }
    }
    // Do not write to a note no copy could be taken of, that is, one that does not exist.
    // core refuses a missing file too, but looking here first lets us say "not found" by name
    let snapshot = magical_merchant_core::snapshot_note(data_dir, filename)?
        .ok_or_else(|| WriteError::NotFound(filename.clone()))?;
    // Ask core where it lives. A note turned into a Codex is not in `notes/`
    let (_, path) = magical_merchant_core::locate_note(data_dir, filename)?;
    let revision = match magical_merchant_core::update_note(&path, body, &context(), expected) {
        Ok(revision) => revision,
        Err(CoreError::Stale(_)) => return Err(WriteError::Stale(filename.clone())),
        Err(e) => return Err(e.into()),
    };
    Ok(Written { snapshot, revision })
}

#[cfg(test)]
mod tests {
    use super::*;
    use magical_merchant_core::Provenance;
    use tempfile::TempDir;

    /// What can be said about the device is the same whether the app or the CLI wrote it.
    /// The difference in entry point is `source`'s job to tell, not a reason for `context`
    /// to thin out.
    #[test]
    fn the_recorded_context_says_as_much_about_the_machine_as_the_app_does() {
        let context = context();
        let probed = magical_merchant_core::utils::device::probe();

        assert_eq!(context.os, std::env::consts::OS);
        assert_eq!(context.arch, std::env::consts::ARCH);
        assert_eq!(context.hostname, probed.hostname);
        assert_eq!(context.os_version, probed.os_version);
        assert_eq!(context.locale, probed.locale);
    }

    /// Only the coordinates are left out. A CLI that runs once and waits for a fix stalls
    /// for seconds every time a `-m` line is written. Filling in old coordinates is worse:
    /// the place it was last opened at stays as the place it was written at.
    #[test]
    fn the_recorded_context_carries_no_location() {
        assert!(context().location.is_none());
    }

    fn seed(base: &Path, body: &str) -> NoteFilename {
        let path = magical_merchant_core::create_draft_note(
            base,
            body,
            &[],
            &context(),
            Provenance::default(),
        )
        .unwrap();
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn body_of(base: &Path, filename: &NoteFilename) -> String {
        magical_merchant_core::read_note_by_filename(base, filename).unwrap()
    }

    /// A note turned into a Codex is still written by the same ID. The write goes where the
    /// Codex lives; it does not recreate an ordinary note of the same ID under `notes/`.
    #[test]
    fn overwriting_a_codex_writes_where_it_lives() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        magical_merchant_core::promote_note_to_codex(tmp.path(), &filename).unwrap();

        overwrite(tmp.path(), &filename, "after", None).unwrap();

        assert_eq!(body_of(tmp.path(), &filename), "after");
        assert!(
            tmp.path()
                .join("data/codex")
                .join(filename.as_str())
                .exists()
        );
        assert!(
            !tmp.path()
                .join("data/notes")
                .join(filename.as_str())
                .exists()
        );
    }

    #[test]
    fn a_read_carries_the_revision_to_pass_back() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "hello");

        let read = read(tmp.path(), &filename).unwrap();

        assert_eq!(read.body, "hello");
        assert_eq!(read.revision, Revision::of("hello"));
    }

    #[test]
    fn overwriting_with_the_read_revision_writes_and_leaves_a_copy() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        let read = read(tmp.path(), &filename).unwrap();

        let written = overwrite(tmp.path(), &filename, "after", Some(&read.revision)).unwrap();

        assert_eq!(body_of(tmp.path(), &filename), "after");
        assert_eq!(written.revision, Revision::of("after"));
        let copy =
            magical_merchant_core::read_note_history(tmp.path(), &filename, &written.snapshot.id)
                .unwrap();
        assert!(copy.ends_with("before"));
    }

    #[test]
    fn overwriting_a_note_someone_else_changed_is_refused_and_keeps_theirs() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        let read = read(tmp.path(), &filename).unwrap();
        overwrite(tmp.path(), &filename, "theirs", None).unwrap();

        let err = overwrite(tmp.path(), &filename, "mine", Some(&read.revision)).unwrap_err();

        assert!(matches!(err, WriteError::Stale(ref f) if *f == filename));
        assert_eq!(body_of(tmp.path(), &filename), "theirs");
        assert_eq!(
            magical_merchant_core::list_note_history(tmp.path(), &filename)
                .unwrap()
                .len(),
            1,
            "only the unguarded write left a copy; the refused one took none"
        );
    }

    #[test]
    fn an_empty_body_and_a_missing_note_are_refused_before_anything_is_written() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "keep");
        let ghost = NoteFilename::parse("20260101_000000.md").unwrap();

        assert!(matches!(
            overwrite(tmp.path(), &filename, "  \n", None),
            Err(WriteError::Empty)
        ));
        assert!(matches!(
            overwrite(tmp.path(), &ghost, "ghost", None),
            Err(WriteError::NotFound(_))
        ));
        assert_eq!(body_of(tmp.path(), &filename), "keep");
        assert!(!tmp.path().join("data/notes/20260101_000000.md").exists());
        assert!(
            magical_merchant_core::list_note_history(tmp.path(), &filename)
                .unwrap()
                .is_empty(),
            "a refused write takes no copy"
        );
    }
}
