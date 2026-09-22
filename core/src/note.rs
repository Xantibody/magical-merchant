pub(crate) mod error;
mod history;
mod kind;
mod repair;
pub(crate) mod repository;
mod revision;
mod summary;
mod version;

pub use history::{Snapshot, list_note_history, read_note_history, restore_note, snapshot_note};
pub use kind::NoteKind;
pub(crate) use repository::Notes;
pub use revision::Revision;
pub use summary::Summary as NoteSummary;
pub use version::{
    BEFORE_RESTORE, DRAFT, Version, VersionStatus, commit_note_version, delete_note_version,
    diff_note_versions, list_note_versions, note_version_status, read_note_version,
    restore_note_version,
};

use std::path::{Path, PathBuf};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, Provenance};
use crate::utils::validated::NoteFilename;

/// Create one note.
///
/// The provenance ([`Provenance`]) is a record that can be written only at creation;
/// [`Provenance::default`] when nothing is declared. Promoting a Scrawl entry is the same call with
/// `origin` attached: growing a function per path would break every signature each time one more
/// provenance record is added.
pub fn create_draft_note(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<PathBuf, CoreError> {
    Notes::new(base_dir.to_path_buf()).create(body, tags, context, provenance)
}

/// Create one Codex (a document that keeps growing and commits versions).
///
/// Only the location becomes `data/codex/`; the naming and the frontmatter are the same as
/// [`create_draft_note`]. It is a separate entry rather than a `kind` argument so that no caller
/// unaware of Codex (CLI, MCP, templates) has to change.
pub fn create_draft_codex(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<PathBuf, CoreError> {
    Notes::new(base_dir.to_path_buf()).create_codex(body, tags, context, provenance)
}

/// Turn a note into a Codex.
///
/// Neither the ID nor the content changes; only the location moves to `data/codex/`. There is no
/// entry back: turning a document that has started committing versions back into a plain note would
/// leave its versions belonging to nothing. If it is already a Codex, nothing happens.
pub fn promote_note_to_codex(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).promote_to_codex(filename)
}

/// Create one note with a given creation time.
///
/// It is the entry for moving in records that lived elsewhere; otherwise it is the same as
/// [`create_draft_note`] (the naming, the one-second step when the same second is taken, and the
/// frontmatter all follow core's rules).
///
/// The filename is the creation time itself, that is, the immutable ID, so naming a moved
/// record after "now" loses its original date for good. Pass the time with its own offset
/// declared: the name is decided by that wall clock too.
pub fn create_note_at(
    base_dir: &Path,
    time: chrono::DateTime<chrono::FixedOffset>,
    body: &str,
    tags: &[String],
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<PathBuf, CoreError> {
    Notes::new(base_dir.to_path_buf()).create_at(time, body, tags, context, provenance)
}

/// Rewrite the body.
///
/// With the [`Revision`] as read attached in `expected`, the write is refused with
/// [`CoreError::Stale`] if the body changed in between. It returns the revision of the written
/// body: the `expected` for the next write.
pub fn update_note(
    file_path: &Path,
    body: &str,
    context: &Context,
    expected: Option<&Revision>,
) -> Result<Revision, CoreError> {
    Notes::update(file_path, body, context, expected)
}

/// Look up a note's kind and actual location from its ID.
///
/// Entries that rewrite the body (CLI, MCP) pass the path obtained here to [`update_note`]:
/// hardcoding `notes/` would make a note turned into a Codex "missing", or recreate a plain note
/// beside it.
pub fn locate_note(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<(NoteKind, PathBuf), CoreError> {
    Notes::new(base_dir.to_path_buf()).locate(filename)
}

pub fn list_notes(base_dir: &Path) -> Result<Vec<NoteSummary>, CoreError> {
    Notes::new(base_dir.to_path_buf()).list()
}

/// Return the note's body. Frontmatter is a matter of the storage format and is not
/// something to show the reader (preview, editor, MCP).
pub fn read_note(file_path: &Path) -> Result<String, CoreError> {
    let content = std::fs::read_to_string(file_path)?;
    Ok(frontmatter::strip(&content).to_string())
}

pub fn read_note_by_filename(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<String, CoreError> {
    Notes::new(base_dir.to_path_buf()).read(filename)
}

pub fn delete_note(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).delete(filename)
}

/// Return one note's frontmatter as it is.
///
/// `NoteSummary` is the digest for the list (with a body preview, and tags already merged with the
/// body's `#` syntax); this is "the record written in the file" itself, which the metadata edit
/// panel looks at.
pub fn read_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<frontmatter::NoteFrontmatter, CoreError> {
    Notes::new(base_dir.to_path_buf()).read_meta(filename)
}

/// Replace only time and tags. The body of course, and context too, are not editable:
/// context is the record of "which device wrote it".
pub fn update_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
    time: chrono::DateTime<chrono::FixedOffset>,
    tags: &[String],
) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).update_meta(filename, time, tags)
}

/// Replace only the view mode. `None` returns it to the default (editor).
/// time / tags / context / body are not touched.
pub fn update_note_view(
    base_dir: &Path,
    filename: &NoteFilename,
    view: Option<&str>,
) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).update_view(filename, view)
}

/// Replace only the link to the entry it was promoted from. `None` cuts the link and
/// makes it an independent note again. time / tags / context / body are not touched.
pub fn update_note_origin(
    base_dir: &Path,
    filename: &NoteFilename,
    origin: Option<&str>,
) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).update_origin(filename, origin)
}

/// Repair garbled metadata that past edits mixed into the body. Returns the number of
/// files repaired.
pub fn repair_notes(base_dir: &Path) -> Result<usize, CoreError> {
    repair::repair_all(&crate::utils::paths::notes_dir(base_dir))
}

/// Move conflict copies that an old build put in `data/` to `conflicts/`.
///
/// Returns the count moved. The app calls it once per process at start, and the sync engine calls
/// it under the lock before every scan.
#[must_use]
pub fn relocate_conflict_copies(base_dir: &Path) -> usize {
    repair::relocate_conflict_copies(base_dir)
}

/// If the same ID is in both `notes/` and `codex/`, move the `notes/` side to `conflicts/`.
///
/// Returns the count moved. The sync engine calls it under the lock before the scan and again after
/// a successful run; the app also calls it once per process at start.
#[must_use]
pub fn relocate_duplicate_ids(base_dir: &Path) -> usize {
    repair::relocate_duplicate_ids(base_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Source;
    use crate::utils::frontmatter::NoteFrontmatter;
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
    fn a_note_promoted_from_an_entry_records_its_origin() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "エントリ本文 #memo",
            &["memo".to_string()],
            &mock_context(),
            promoted_from("2026-08-13T08:30:00"),
        )
        .unwrap();

        let meta = read_note_meta(
            tmp.path(),
            &NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));

        // It is on the list too. Scrawl's chips are derived from here
        let listed = list_notes(tmp.path()).unwrap();
        assert_eq!(listed[0].origin, Some("2026-08-13T08:30:00".to_string()));
    }

    #[test]
    fn test_create_draft_note_returns_path() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "draft body",
            &[],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap();
        let content = fs::read_to_string(&path).unwrap();
        // origin is a record only for notes that came from an entry. Writing it on a plain
        // new note would make every note "come from some entry"
        assert!(!content.contains("origin"));
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("draft body"));
    }

    /// A note created with a given time is named after that time. The ID is the creation
    /// time itself, so a record brought in from outside can only copy its original time
    /// into the name.
    #[test]
    fn a_note_created_at_a_given_time_is_named_after_it() {
        let tmp = TempDir::new().unwrap();

        let path = create_note_at(
            tmp.path(),
            sample_time(),
            "移してきた本文",
            &["memo".to_string()],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(path.file_name().unwrap(), "20260503_153900.md");
        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();
        assert_eq!(meta.time, sample_time());
        assert_eq!(meta.tags, vec!["memo"]);
        assert_eq!(read_note(&path).unwrap(), "移してきた本文");
    }

    /// Collision avoidance is the same with a given time. The first stays, the second takes
    /// a name one second later, and its `time` matches the later one too.
    #[test]
    fn two_notes_given_the_same_time_both_survive_one_second_apart() {
        let tmp = TempDir::new().unwrap();
        let at = |body| {
            create_note_at(
                tmp.path(),
                sample_time(),
                body,
                &[],
                &mock_context(),
                Provenance::default(),
            )
            .unwrap()
        };

        let first = at("one");
        let second = at("two");

        assert_eq!(first.file_name().unwrap(), "20260503_153900.md");
        assert_eq!(second.file_name().unwrap(), "20260503_153901.md");
        assert_eq!(read_note(&first).unwrap(), "one");
        assert_eq!(read_note(&second).unwrap(), "two");
        assert_eq!(
            read_note_meta(tmp.path(), &filename_of(&second))
                .unwrap()
                .time,
            sample_time() + chrono::Duration::seconds(1)
        );
    }

    /// An import declares itself by its own name. This record is the only way to find
    /// "which ones were moved in" later (mixed into `cli`, they cannot be told apart).
    #[test]
    fn an_imported_note_names_import_as_its_source() {
        let tmp = TempDir::new().unwrap();

        let path = create_note_at(
            tmp.path(),
            sample_time(),
            "vault から",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Import),
                template: Some("journal"),
                ..Provenance::default()
            },
        )
        .unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();
        assert_eq!(meta.source, Some("import".to_string()));
        assert_eq!(meta.template, Some("journal".to_string()));
        assert_eq!(meta.updated, None, "取り込んだ時点ではまだ書き直していない");
    }

    /// The filename is the time down to the second. Creating two in the same second does
    /// not clobber the first. The second takes a name one second later: the format
    /// (`YYYYMMDD_HHMMSS.md`) is immutable.
    #[test]
    fn two_notes_created_in_the_same_second_both_survive() {
        let tmp = TempDir::new().unwrap();

        let first = draft(&tmp, "one", &[]).unwrap();
        let second = draft(&tmp, "two", &[]).unwrap();

        assert_ne!(first, second);
        assert_eq!(read_note(&first).unwrap(), "one");
        assert_eq!(read_note(&second).unwrap(), "two");
        assert_eq!(list_notes(tmp.path()).unwrap().len(), 2);
        assert_eq!(
            stamp_of(&second) - stamp_of(&first),
            chrono::Duration::seconds(1)
        );
    }

    /// The shifted second is not only about the filename. If the frontmatter `time` drifts
    /// from the name, the list (name order) and the display (`time`) disagree on the order.
    #[test]
    fn a_shifted_name_carries_the_same_time_in_the_frontmatter() {
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "one", &[]).unwrap();

        let second = draft(&tmp, "two", &[]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&second)).unwrap();
        assert_eq!(
            meta.time.naive_local().format("%Y%m%d_%H%M%S").to_string(),
            second.file_stem().unwrap().to_str().unwrap()
        );
    }

    fn stamp_of(path: &Path) -> chrono::NaiveDateTime {
        let stem = path.file_stem().unwrap().to_str().unwrap();
        chrono::NaiveDateTime::parse_from_str(stem, "%Y%m%d_%H%M%S").unwrap()
    }

    #[test]
    fn test_update_note_overwrites() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("updated"));
        assert!(!content.contains("original"));
    }

    /// time is the creation time. The list is ordered by filename (creation time), so if an
    /// edit moved time, the date groups and the order would disagree.
    #[test]
    fn update_note_keeps_the_creation_time() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let original = fs::read_to_string(&path).unwrap();
        let (fm_before, _) = frontmatter::parse::<NoteFrontmatter>(&original).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        let (fm_after, body) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        assert_eq!(fm_after.time, fm_before.time);
        assert_eq!(body, "updated");
    }

    /// With time fixed to the creation time, the fact of a rewrite is recorded nowhere
    /// else. Only a body save stamps updated.
    #[test]
    fn update_note_stamps_the_updated_time() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let filename = filename_of(&path);
        assert_eq!(read_note_meta(tmp.path(), &filename).unwrap().updated, None);

        // The creation time is rounded to the second, so the moment of the rewrite is later
        // than it. `>= time` would pass even if the creation time were merely copied
        let before = chrono::Local::now();
        update_note(&path, "updated", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        let updated = meta.updated.expect("updated is stamped");
        assert!(updated >= before, "updated {updated} < before {before}");
        assert!(updated <= chrono::Local::now());
    }

    /// If another writer changed the body between the read and the write, do not write over
    /// it. The app does not watch files, so typing into a note that was rewritten outside
    /// (CLI, MCP) while it is open would overwrite the old body along with it.
    #[test]
    fn update_note_refuses_to_overwrite_a_body_that_moved_since_it_was_read() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let read = Revision::of(&read_note(&path).unwrap());
        update_note(&path, "someone else", &mock_context(), None).unwrap();

        let result = update_note(&path, "mine", &mock_context(), Some(&read));

        assert!(
            matches!(result, Err(CoreError::Stale(ref name)) if name == filename_of(&path).as_str())
        );
        assert_eq!(read_note(&path).unwrap(), "someone else");
    }

    #[test]
    fn update_note_with_the_current_revision_writes_and_returns_the_next_one() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let read = Revision::of(&read_note(&path).unwrap());

        let next = update_note(&path, "mine", &mock_context(), Some(&read)).unwrap();

        assert_eq!(read_note(&path).unwrap(), "mine");
        assert_eq!(next, Revision::of("mine"));
        // The returned revision lets the next write go through
        update_note(&path, "again", &mock_context(), Some(&next)).unwrap();
        assert_eq!(read_note(&path).unwrap(), "again");
    }

    /// A note whose frontmatter cannot be read gets no body written back. Making up the
    /// current time and the current device and writing would lose the creation time, tags,
    /// provenance and view mode on a one-character edit, and the filename and `time` would
    /// disagree. The same reason the metadata edit (`update_note_meta`) refuses.
    #[test]
    fn update_note_refuses_a_note_whose_frontmatter_cannot_be_read() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let broken = "---\ntime: [broken\ntags: [仕事]\n---\n本文";
        let path = notes_dir.join("20260101_120000.md");
        fs::write(&path, broken).unwrap();

        let result = update_note(&path, "書き足した", &mock_context(), None);

        assert!(matches!(result, Err(CoreError::Parse(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), broken);
    }

    /// A file with no closing delimiter is on the "damaged record" side too. The lines under
    /// `---` were written as a record, and recreating it as plain Markdown would wipe them
    /// whole. A write cut off midway, or a file sync delivered only half of, ends up in
    /// this shape, so letting it pass here would defeat both the `parse` refusal and the
    /// screen's fallback.
    #[test]
    fn update_note_refuses_a_note_whose_frontmatter_delimiter_is_unclosed() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let truncated = "---\ntime: 2026-01-01T12:00:00+09:00\ntags:\n  - 仕事\n";
        let path = notes_dir.join("20260101_120000.md");
        fs::write(&path, truncated).unwrap();

        let result = update_note(&path, "書き足した", &mock_context(), None);

        assert!(matches!(result, Err(CoreError::Parse(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), truncated);
    }

    /// A file that cannot be read as text (invalid UTF-8). It ends up in this shape when
    /// sync or an outside tool replaces an open note with broken bytes or a file in another
    /// format. Returned as `Io`, the caller could not tell it from "the disk is briefly
    /// unwell", and a refusal that rereading cannot fix would look like "retry later".
    /// Return it as a named refusal and save the typed text aside.
    #[test]
    fn update_note_refuses_a_note_whose_bytes_are_not_text() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let garbled: &[u8] = b"---\ntime: 2026-01-01T12:00:00+09:00\n---\n\xff\xfe";
        let path = notes_dir.join("20260101_120000.md");
        fs::write(&path, garbled).unwrap();

        let result = update_note(&path, "書き足した", &mock_context(), None);

        assert!(
            matches!(result, Err(CoreError::NotText(ref name)) if name.contains("20260101_120000.md"))
        );
        assert_eq!(fs::read(&path).unwrap(), garbled);
    }

    /// A file with no delimiter at all (plain Markdown placed from outside) is written with
    /// a record attached, as before. Unlike a damaged record, recreating it loses nothing.
    #[test]
    fn update_note_gives_a_plain_markdown_file_its_first_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let path = notes_dir.join("20260101_120000.md");
        fs::write(&path, "よそで書いた本文").unwrap();

        update_note(&path, "書き足した", &mock_context(), None).unwrap();

        let filename = NoteFilename::parse("20260101_120000.md").unwrap();
        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.context.unwrap().battery, Some(50));
        assert_eq!(read_note(&path).unwrap(), "書き足した");
    }

    /// Saving to a deleted note is not an entry for recreating it. A late save from a tab
    /// the writer left open would bring a deleted note, or one moved to Codex, back to life
    /// in its old location as a bare body.
    #[test]
    fn update_note_refuses_a_file_that_is_not_there_and_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        delete_note(tmp.path(), &filename_of(&path)).unwrap();

        let result = update_note(&path, "back from the dead", &mock_context(), None);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
        assert!(!path.exists());
    }

    /// The revision is taken from the body only. Switching the view mode while editing
    /// does not make one's own save "stale".
    #[test]
    fn a_metadata_edit_does_not_make_the_body_revision_stale() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let filename = filename_of(&path);
        let read = Revision::of(&read_note(&path).unwrap());
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note(&path, "mine", &mock_context(), Some(&read)).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
        assert_eq!(read_note(&path).unwrap(), "mine");
    }

    /// Replacing metadata or the view mode does not rewrite the body. Stamping updated here
    /// would mean "the updated date moves without an edit".
    #[test]
    fn update_note_meta_and_view_do_not_stamp_updated() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(read_note_meta(tmp.path(), &filename).unwrap().updated, None);
    }

    /// A stamped updated must not be lost by a later metadata edit.
    #[test]
    fn update_note_meta_keeps_the_updated_time() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);
        update_note(&path, "edited", &mock_context(), None).unwrap();
        let stamped = read_note_meta(tmp.path(), &filename).unwrap().updated;

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().updated,
            stamped
        );
    }

    /// The entry point that wrote it is decided at creation. A note created by the CLI says so.
    #[test]
    fn a_note_records_the_tool_that_created_it() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "CLI から書いた",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Cli),
                ..Provenance::default()
            },
        )
        .unwrap();

        assert!(fs::read_to_string(&path).unwrap().contains("source: cli"));
        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();
        assert_eq!(meta.source, Some("cli".to_string()));
    }

    /// No declaration, no key. The same promise as rewriting an existing note not
    /// growing a `source`.
    #[test]
    fn a_note_that_names_no_source_has_no_source_key() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();

        assert!(!fs::read_to_string(&path).unwrap().contains("source"));
    }

    /// `source` is a record from creation. Rewriting the body with another tool does not
    /// change "who created it" (`updated_by` is a different question).
    #[test]
    fn update_note_keeps_the_creation_source() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "original",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Widget),
                ..Provenance::default()
            },
        )
        .unwrap();

        update_note(&path, "アプリで書き直した", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();
        assert_eq!(meta.source, Some("widget".to_string()));
    }

    /// Neither a metadata edit nor a view-mode switch writes the body.
    /// Still less do they touch the creation record.
    #[test]
    fn update_note_meta_and_view_do_not_touch_the_source() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "body",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Mcp),
                ..Provenance::default()
            },
        )
        .unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &["log".to_string()]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().source,
            Some("mcp".to_string())
        );
    }

    /// context is the record of "which device wrote it". Editing on another device must
    /// not overwrite the record from creation.
    #[test]
    fn update_note_keeps_the_creation_context() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();

        let other_device = Context {
            battery: Some(1),
            is_charging: Some(true),
            ..Context::default()
        };
        update_note(&path, "updated", &other_device, None).unwrap();

        let updated = fs::read_to_string(&path).unwrap();
        let (fm, _) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(50));
        assert_eq!(ctx.is_charging, Some(false));
    }

    /// Editing a note tagged back when the tag field was used must not lose its category.
    #[test]
    fn update_note_keeps_tags_that_predate_the_hash_syntax() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &["sync".to_string()]).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        assert!(fs::read_to_string(&path).unwrap().contains("sync"));
    }

    #[test]
    fn test_list_notes_empty() {
        let tmp = TempDir::new().unwrap();
        let notes = list_notes(tmp.path()).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn test_list_notes_returns_summaries() {
        let tmp = TempDir::new().unwrap();
        let tags = vec!["rust".to_string(), "test".to_string()];
        draft(&tmp, "# Hello\nBody text here", &tags).unwrap();

        let notes = list_notes(tmp.path()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].tags, vec!["rust", "test"]);
        assert!(notes[0].time.is_some());
        assert!(notes[0].preview.contains("Hello"));
    }

    #[test]
    fn test_read_note() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "full content", &[]).unwrap();
        let content = read_note(&path).unwrap();
        assert!(content.contains("full content"));
    }

    /// A read returns only the body. Returning the frontmatter would flow straight into
    /// the preview or the editor and put metadata on screen.
    #[test]
    fn read_note_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
    }

    /// Search and backlinks read every note's body. Calling `read_note` one by one after
    /// the list would mean two open(2) calls each, so the summary and body are passed together.
    #[test]
    fn scan_visits_each_summary_with_its_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody #memo", &[]).unwrap();

        let mut visited = Vec::new();
        Notes::new(tmp.path().to_path_buf())
            .scan(|summary, body| visited.push((summary, body.to_string())))
            .unwrap();

        assert_eq!(visited.len(), 1);
        let (summary, body) = &visited[0];
        assert_eq!(summary.path, path);
        assert_eq!(summary.tags, vec!["memo".to_string()]);
        assert_eq!(body, "# Title\nbody #memo");
    }

    #[test]
    fn read_note_by_filename_returns_body_without_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();

        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();

        assert_eq!(content, "# Title\nbody");
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

    #[test]
    fn test_delete_note_path_traversal() {
        assert!(NoteFilename::parse("../etc/passwd").is_err());
    }

    #[test]
    fn test_delete_note_rejects_absolute_path() {
        assert!(NoteFilename::parse("/tmp/evil.md").is_err());
    }

    #[test]
    fn test_read_note_by_filename() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "readable content", &[]).unwrap();
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();
        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();
        assert!(content.contains("readable content"));
    }

    #[test]
    fn test_read_note_by_filename_path_traversal() {
        assert!(NoteFilename::parse("../etc/passwd").is_err());
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
    fn test_validate_rejects_non_md_extension() {
        assert!(NoteFilename::parse("evil.txt").is_err());
    }

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn sample_time() -> chrono::DateTime<chrono::FixedOffset> {
        use chrono::TimeZone as _;
        chrono::FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 5, 3, 15, 39, 0)
            .unwrap()
    }

    #[test]
    fn read_note_meta_returns_time_tags_and_context() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &["sync".to_string()]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename_of(&path)).unwrap();

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

    #[test]
    fn update_note_meta_replaces_time_and_tags() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &["old".to_string()]).unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &["log".to_string()]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, sample_time());
        assert_eq!(meta.tags, vec!["log"]);
    }

    /// A metadata edit must not move the body. The reverse (a body edit keeps the
    /// metadata) is covered by the tests on the `update_note` side.
    #[test]
    fn update_note_meta_keeps_body_and_context() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();
        let filename = filename_of(&path);

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.context.unwrap().battery, Some(50));
    }

    /// Making up time/tags and writing them into a file whose frontmatter cannot be read
    /// would make a damaged record look legitimate. Refuse without writing.
    #[test]
    fn update_note_meta_rejects_broken_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let notes_dir = tmp.path().join("data/notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let broken = "---\ntime: [broken\n---\nbody";
        fs::write(notes_dir.join("20260101_120000.md"), broken).unwrap();
        let filename = NoteFilename::parse("20260101_120000.md").unwrap();

        let result = update_note_meta(tmp.path(), &filename, sample_time(), &[]);

        assert!(matches!(result, Err(CoreError::Parse(_))));
        let content = fs::read_to_string(notes_dir.join("20260101_120000.md")).unwrap();
        assert_eq!(content, broken);
    }

    #[test]
    fn update_note_view_sets_mindmap() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);

        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    #[test]
    fn update_note_view_none_clears_the_key() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note_view(tmp.path(), &filename, None).unwrap();

        assert!(!fs::read_to_string(&path).unwrap().contains("view"));
    }

    /// A view-mode switch must not move the body or the metadata records.
    #[test]
    fn update_note_view_keeps_body_time_and_context() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "# Title\nbody", &[]).unwrap();
        let filename = filename_of(&path);
        let before = read_note_meta(tmp.path(), &filename).unwrap();

        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(read_note(&path).unwrap(), "# Title\nbody");
        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, before.time);
        assert_eq!(meta.context.unwrap().battery, Some(50));
    }

    /// If a body save lost the view mode, every reopen would fall back to the editor.
    #[test]
    fn update_note_keeps_the_view_mode() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "original", &[]).unwrap();
        let filename = filename_of(&path);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note(&path, "updated", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    /// A time/tags edit keeps the view mode too.
    #[test]
    fn update_note_meta_keeps_the_view_mode() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "body", &[]).unwrap();
        let filename = filename_of(&path);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    fn promoted_from(origin: &str) -> Provenance<'_> {
        Provenance {
            origin: Some(origin),
            ..Provenance::default()
        }
    }

    fn promoted_note(tmp: &TempDir) -> NoteFilename {
        let path = create_draft_note(
            tmp.path(),
            "エントリ本文",
            &[],
            &mock_context(),
            promoted_from("2026-08-13T08:30:00"),
        )
        .unwrap();
        filename_of(&path)
    }

    #[test]
    fn update_note_origin_none_clears_the_key() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);

        update_note_origin(tmp.path(), &filename, None).unwrap();

        let content =
            fs::read_to_string(tmp.path().join("data/notes").join(filename.as_str())).unwrap();
        assert!(!content.contains("origin"));
    }

    /// Unlinking only cuts the link; it does not touch the note's own records.
    #[test]
    fn update_note_origin_keeps_body_time_and_context() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);
        let before = read_note_meta(tmp.path(), &filename).unwrap();

        update_note_origin(tmp.path(), &filename, None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, before.time);
        assert_eq!(meta.context.unwrap().battery, Some(50));
        assert!(
            read_note_by_filename(tmp.path(), &filename)
                .unwrap()
                .contains("エントリ本文")
        );
    }

    /// The undo (relink) path. The unlinked value can be written back as it was.
    #[test]
    fn update_note_origin_restores_the_link() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);
        update_note_origin(tmp.path(), &filename, None).unwrap();

        update_note_origin(tmp.path(), &filename, Some("2026-08-13T08:30:00")).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    #[test]
    fn update_note_origin_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = update_note_origin(tmp.path(), &filename, None);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// If a body save lost the link to the entry it was promoted from, Scrawl's chip
    /// would vanish on every edit.
    #[test]
    fn update_note_keeps_the_origin() {
        let tmp = TempDir::new().unwrap();
        let filename = promoted_note(&tmp);
        let path = tmp.path().join("data/notes").join(filename.as_str());

        update_note(&path, "書き直した本文", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));
    }

    #[test]
    fn update_note_view_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = update_note_view(tmp.path(), &filename, Some("mindmap"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn update_note_meta_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let filename = NoteFilename::parse("nonexistent.md").unwrap();

        let result = update_note_meta(tmp.path(), &filename, sample_time(), &[]);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
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

    /// A Codex goes in `codex/`, not `notes/`. The kind is decided by the location, and the
    /// ID (filename) alone finds it in either location.
    #[test]
    fn a_codex_lives_in_its_own_directory_and_is_found_by_filename() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "育てる文書");
        let filename = filename_of(&path);

        assert!(path.starts_with(tmp.path().join("data/codex")));
        let listed = list_notes(tmp.path()).unwrap();
        assert_eq!(listed[0].kind, NoteKind::Codex);
        assert_eq!(listed[0].path, path);
        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "育てる文書"
        );
        assert!(read_note_meta(tmp.path(), &filename).is_ok());

        let note = draft(&tmp, "普通のノート", &[]).unwrap();
        let listed = list_notes(tmp.path()).unwrap();
        let of = |p: &Path| listed.iter().find(|s| s.path == p).unwrap().kind;
        assert_eq!(of(&note), NoteKind::Note);
        assert_eq!(of(&path), NoteKind::Codex);
    }

    /// IDs share one namespace across kinds. Creating a Note and a Codex in the same second
    /// never gives them the same name; the later one steps one second ahead.
    #[test]
    fn a_note_and_a_codex_never_share_an_id() {
        let tmp = TempDir::new().unwrap();
        let note = create_note_at(
            tmp.path(),
            sample_time(),
            "note",
            &[],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap();
        fs::create_dir_all(tmp.path().join("data/codex")).unwrap();
        fs::copy(&note, tmp.path().join("data/codex/20260503_153901.md")).unwrap();

        let second = create_note_at(
            tmp.path(),
            sample_time(),
            "another",
            &[],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(second.file_name().unwrap(), "20260503_153902.md");
    }

    /// Promotion only changes the location. Neither the ID, the frontmatter nor the body
    /// changes by a byte.
    #[test]
    fn promoting_moves_the_file_without_touching_its_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "育てる #memo", &[]).unwrap();
        let filename = filename_of(&path);
        let before = fs::read(&path).unwrap();

        promote_note_to_codex(tmp.path(), &filename).unwrap();
        promote_note_to_codex(tmp.path(), &filename).unwrap();

        assert!(!path.exists());
        let moved = tmp.path().join("data/codex").join(filename.as_str());
        assert_eq!(fs::read(&moved).unwrap(), before);
        let listed = list_notes(tmp.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, NoteKind::Codex);
        assert_eq!(listed[0].path, moved);
    }

    #[test]
    fn promoting_a_missing_note_is_not_found() {
        let tmp = TempDir::new().unwrap();
        let filename = NoteFilename::parse("20260503_153900.md").unwrap();

        let result = promote_note_to_codex(tmp.path(), &filename);

        assert!(matches!(result, Err(CoreError::NotFound(_))));
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

    /// When a promotion and an offline edit on another device land on the same ID, sync
    /// delivers the notes/ side as a new file. The Codex side stays, and the notes/ side is
    /// set aside in the same place as conflict copies.
    #[test]
    fn a_duplicate_id_in_notes_is_moved_to_conflicts() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "codex 側");
        let filename = filename_of(&path);
        let stale = tmp.path().join("data/notes").join(filename.as_str());
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "notes 側").unwrap();

        assert_eq!(relocate_duplicate_ids(tmp.path()), 1);

        assert!(!stale.exists());
        assert!(fs::read_to_string(&path).unwrap().contains("codex 側"));
        let stem = filename.as_str().trim_end_matches(".md");
        let copies: Vec<_> = fs::read_dir(tmp.path().join("conflicts/notes").join(stem))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read_to_string(copies[0].path()).unwrap(), "notes 側");
        assert_eq!(relocate_duplicate_ids(tmp.path()), 0);
    }
}
