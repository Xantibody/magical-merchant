mod history;
mod repair;
pub(crate) mod repository;
pub(crate) mod version;

pub use history::{Snapshot, list_note_history, read_note_history, restore_note, snapshot_note};
pub(crate) use repository::Notes;
pub use version::{
    BEFORE_RESTORE, DRAFT, Version, VersionStatus, commit_note_version, delete_note_version,
    diff_note_versions, list_note_versions, note_version_status, read_note_version,
    restore_note_version,
};

use std::path::Path;

use crate::domain::note::{NoteFilename, Revision};
use crate::error::CoreError;
use crate::utils::clock::Stamp;
use crate::utils::device::Context;

/// Turn a note into a Codex.
///
/// Neither the ID nor the content changes; only the location moves to `data/codex/`. There is no
/// entry back: turning a document that has started committing versions back into a plain note would
/// leave its versions belonging to nothing. If it is already a Codex, nothing happens.
pub fn promote_note_to_codex(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).promote_to_codex(filename)
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

pub fn delete_note(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Notes::new(base_dir.to_path_buf()).delete(filename)
}

/// Replace only time and tags. The body of course, and context too, are not editable:
/// context is the record of "which device wrote it".
pub fn update_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
    time: Stamp,
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
    repair::repair_all(&crate::domain::note::kind::notes_dir(base_dir))
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
    use crate::domain::note::{
        NoteFrontmatter, NoteKind, Provenance, create_draft_codex, create_draft_note, list_notes,
        read_note, read_note_by_filename, read_note_meta,
    };
    use crate::utils::device::Source;
    use crate::utils::frontmatter;
    use std::fs;
    use std::path::PathBuf;
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
        let before = Stamp::now_local();
        update_note(&path, "updated", &mock_context(), None).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        let updated = meta.updated.expect("updated is stamped");
        assert!(updated >= before, "updated {updated:?} < before {before:?}");
        assert!(updated <= Stamp::now_local());
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

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn sample_time() -> Stamp {
        Stamp::new(2026, 5, 3, 15, 39, 0, 9 * 3600).unwrap()
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

    /// A Codex is already where promotion would put it, so asking again is not a failure
    /// and does not touch the file.
    #[test]
    fn promoting_a_codex_again_changes_nothing() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "育てる文書");
        let filename = filename_of(&path);
        let before = fs::read(&path).unwrap();

        promote_note_to_codex(tmp.path(), &filename).unwrap();

        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(
            !tmp.path()
                .join("data/notes")
                .join(filename.as_str())
                .exists()
        );
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
