//! Saving the body from the writing screen (and from the CLI and MCP).

use std::path::Path;

use crate::domain::device::Context;
use crate::domain::note::file;
use crate::domain::note::{NoteFilename, Revision, locate_note};
use crate::services::files::{read_existing_text, write_atomic};
use crate::utils::clock::Stamp;
use crate::utils::error::CoreError;

/// Rewrite the body of the note with this ID.
///
/// It is written where the note lives now: a note turned into a Codex is written in
/// `data/codex/`, and hardcoding `notes/` would call it missing or grow a plain note of the
/// same ID beside it.
///
/// With the [`Revision`] as read attached in `expected`, the write is refused with
/// [`CoreError::Stale`] if the body changed in between. It returns the revision of the written
/// body: the `expected` for the next write.
///
/// It reads the file, lets `file::rewrite` decide the new text, and writes it back.
///
/// A file that cannot be read as text is refused ([`CoreError::NotText`]).
/// Its content could not be read, so neither the `expected` check nor the
/// frontmatter carry-over is possible, and writing would overwrite the
/// unreadable bytes with the body.
///
/// A missing note is not written ([`CoreError::NotFound`]). This path replaces
/// the body of an existing note; creation happens only in the `create` family.
/// If it could write, a deleted note or one moved to Codex would come back to
/// life in its old directory through a late save from a screen still open.
pub fn update_note(
    base_dir: &Path,
    filename: &NoteFilename,
    body: &str,
    context: &Context,
    expected: Option<&Revision>,
) -> Result<Revision, CoreError> {
    let (_, file_path) = locate_note(base_dir, filename)?;
    // A file that cannot be read as text is refused for the same reason on every
    // rewrite or re-read. Folded into `Io`, the caller cannot tell it from a transient
    // fault, and a save that was given up on is treated as one that "will go through later"
    let existing = read_existing_text(&file_path)?;
    let markdown = file::rewrite(
        &existing,
        body,
        context,
        expected,
        Stamp::now_local(),
        filename.as_str(),
    )?;
    write_atomic(&file_path, markdown)?;
    Ok(Revision::of(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::codex::promote_note_to_codex;
    use crate::domain::device::Source;
    use crate::domain::note::{
        NoteFrontmatter, NoteKind, Provenance, create_draft, delete_note, read_note_by_filename,
        read_note_meta, update_note_view,
    };
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
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> NoteFilename {
        create_draft(
            tmp.path(),
            NoteKind::Note,
            body,
            tags,
            &mock_context(),
            Provenance::default(),
        )
        .unwrap()
    }

    /// Where a plain note with this ID sits.
    fn path_of(tmp: &TempDir, filename: &NoteFilename) -> PathBuf {
        NoteKind::Note.dir(tmp.path()).join(filename.as_str())
    }

    fn body_of(tmp: &TempDir, filename: &NoteFilename) -> String {
        read_note_by_filename(tmp.path(), filename).unwrap()
    }

    fn save(tmp: &TempDir, filename: &NoteFilename, body: &str) -> Result<Revision, CoreError> {
        update_note(tmp.path(), filename, body, &mock_context(), None)
    }

    /// A note placed by hand under `data/notes/` with this exact content.
    fn placed(tmp: &TempDir, content: &[u8]) -> (NoteFilename, PathBuf) {
        let filename = NoteFilename::parse("20260101_120000.md").unwrap();
        let path = path_of(tmp, &filename);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        (filename, path)
    }

    /// time is the creation time. The list is ordered by filename (creation time), so if an
    /// edit moved time, the date groups and the order would disagree.
    #[test]
    fn update_note_keeps_the_creation_time() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        let original = fs::read_to_string(path_of(&tmp, &filename)).unwrap();
        let (fm_before, _) = frontmatter::parse::<NoteFrontmatter>(&original).unwrap();

        save(&tmp, &filename, "updated").unwrap();

        let updated = fs::read_to_string(path_of(&tmp, &filename)).unwrap();
        let (fm_after, body) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        assert_eq!(fm_after.time, fm_before.time);
        assert_eq!(body, "updated");
    }

    /// With time fixed to the creation time, the fact of a rewrite is recorded nowhere
    /// else. Only a body save stamps updated.
    #[test]
    fn update_note_stamps_the_updated_time() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        assert_eq!(read_note_meta(tmp.path(), &filename).unwrap().updated, None);

        // The creation time is rounded to the second, so the moment of the rewrite is later
        // than it. `>= time` would pass even if the creation time were merely copied
        let before = Stamp::now_local();
        save(&tmp, &filename, "updated").unwrap();

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
        let filename = draft(&tmp, "original", &[]);
        let read = Revision::of(&body_of(&tmp, &filename));
        save(&tmp, &filename, "someone else").unwrap();

        let result = update_note(tmp.path(), &filename, "mine", &mock_context(), Some(&read));

        assert!(matches!(result, Err(CoreError::Stale(ref name)) if name == filename.as_str()));
        assert_eq!(body_of(&tmp, &filename), "someone else");
    }

    #[test]
    fn update_note_with_the_current_revision_writes_and_returns_the_next_one() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        let read = Revision::of(&body_of(&tmp, &filename));

        let next =
            update_note(tmp.path(), &filename, "mine", &mock_context(), Some(&read)).unwrap();

        assert_eq!(body_of(&tmp, &filename), "mine");
        assert_eq!(next, Revision::of("mine"));
        // The returned revision lets the next write go through
        update_note(tmp.path(), &filename, "again", &mock_context(), Some(&next)).unwrap();
        assert_eq!(body_of(&tmp, &filename), "again");
    }

    /// A note turned into a Codex is still written by the same ID. The write goes where the
    /// Codex lives; it does not recreate an ordinary note of the same ID under `notes/`.
    #[test]
    fn update_note_writes_a_promoted_note_where_the_codex_lives() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        promote_note_to_codex(tmp.path(), &filename).unwrap();

        save(&tmp, &filename, "after").unwrap();

        assert_eq!(body_of(&tmp, &filename), "after");
        assert!(!path_of(&tmp, &filename).exists());
    }

    /// A note whose frontmatter cannot be read gets no body written back. Making up the
    /// current time and the current device and writing would lose the creation time, tags,
    /// provenance and view mode on a one-character edit, and the filename and `time` would
    /// disagree. The same reason the metadata edit (`update_note_meta`) refuses.
    #[test]
    fn update_note_refuses_a_note_whose_frontmatter_cannot_be_read() {
        let tmp = TempDir::new().unwrap();
        let broken = "---\ntime: [broken\ntags: [仕事]\n---\n本文";
        let (filename, path) = placed(&tmp, broken.as_bytes());

        let result = save(&tmp, &filename, "書き足した");

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
        let truncated = "---\ntime: 2026-01-01T12:00:00+09:00\ntags:\n  - 仕事\n";
        let (filename, path) = placed(&tmp, truncated.as_bytes());

        let result = save(&tmp, &filename, "書き足した");

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
        let garbled: &[u8] = b"---\ntime: 2026-01-01T12:00:00+09:00\n---\n\xff\xfe";
        let (filename, path) = placed(&tmp, garbled);

        let result = save(&tmp, &filename, "書き足した");

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
        let (filename, _) = placed(&tmp, "よそで書いた本文".as_bytes());

        save(&tmp, &filename, "書き足した").unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.context.unwrap().battery, Some(50));
        assert_eq!(body_of(&tmp, &filename), "書き足した");
    }

    /// Saving to a deleted note is not an entry for recreating it. A late save from a tab
    /// the writer left open would bring a deleted note, or one moved to Codex, back to life
    /// in its old location as a bare body.
    #[test]
    fn update_note_refuses_a_file_that_is_not_there_and_creates_nothing() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        delete_note(tmp.path(), &filename).unwrap();

        let result = save(&tmp, &filename, "back from the dead");

        assert!(matches!(result, Err(CoreError::NotFound(_))));
        assert!(!path_of(&tmp, &filename).exists());
    }

    /// The revision is taken from the body only. Switching the view mode while editing
    /// does not make one's own save "stale".
    #[test]
    fn a_metadata_edit_does_not_make_the_body_revision_stale() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        let read = Revision::of(&body_of(&tmp, &filename));
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        update_note(tmp.path(), &filename, "mine", &mock_context(), Some(&read)).unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
        assert_eq!(body_of(&tmp, &filename), "mine");
    }

    /// `source` is a record from creation. Rewriting the body with another tool does not
    /// change "who created it" (`updated_by` is a different question).
    #[test]
    fn update_note_keeps_the_creation_source() {
        let tmp = TempDir::new().unwrap();
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            "original",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Widget),
                ..Provenance::default()
            },
        )
        .unwrap();

        save(&tmp, &filename, "アプリで書き直した").unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.source, Some("widget".to_string()));
    }

    /// context is the record of "which device wrote it". Editing on another device must
    /// not overwrite the record from creation.
    #[test]
    fn update_note_keeps_the_creation_context() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);

        let other_device = Context {
            battery: Some(1),
            is_charging: Some(true),
            ..Context::default()
        };
        update_note(tmp.path(), &filename, "updated", &other_device, None).unwrap();

        let updated = fs::read_to_string(path_of(&tmp, &filename)).unwrap();
        let (fm, _) = frontmatter::parse::<NoteFrontmatter>(&updated).unwrap();
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(50));
        assert_eq!(ctx.is_charging, Some(false));
    }

    /// Editing a note tagged back when the tag field was used must not lose its category.
    #[test]
    fn update_note_keeps_tags_that_predate_the_hash_syntax() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &["sync".to_string()]);

        save(&tmp, &filename, "updated").unwrap();

        assert!(
            fs::read_to_string(path_of(&tmp, &filename))
                .unwrap()
                .contains("sync")
        );
    }

    /// If a body save lost the view mode, every reopen would fall back to the editor.
    #[test]
    fn update_note_keeps_the_view_mode() {
        let tmp = TempDir::new().unwrap();
        let filename = draft(&tmp, "original", &[]);
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        save(&tmp, &filename, "updated").unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.view, Some("mindmap".to_string()));
    }

    /// If a body save lost the link to the entry it was promoted from, Scrawl's chip
    /// would vanish on every edit.
    #[test]
    fn update_note_keeps_the_origin() {
        let tmp = TempDir::new().unwrap();
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            "エントリ本文",
            &[],
            &mock_context(),
            Provenance {
                origin: Some("2026-08-13T08:30:00"),
                ..Provenance::default()
            },
        )
        .unwrap();

        save(&tmp, &filename, "書き直した本文").unwrap();

        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.origin, Some("2026-08-13T08:30:00".to_string()));
    }
}
