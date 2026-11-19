//! Making a Note or a Codex: the name is taken first, then filled.

use std::path::{Path, PathBuf};

use crate::domain::note::NoteKind;
use crate::domain::note::file::{Provenance, format_note_markdown};
use crate::error::CoreError;
use crate::services::files::{create_new_with, ensure_dir, exists};
use crate::utils::clock::Stamp;
use crate::utils::device::Context;

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
    create_note_at(
        base_dir,
        Stamp::now_local(),
        body,
        tags,
        context,
        provenance,
    )
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
    create_kind_at(
        base_dir,
        NoteKind::Codex,
        Stamp::now_local(),
        body,
        tags,
        context,
        provenance,
    )
}

/// Create one note with a given creation time. Returns the path of the file written.
///
/// It is the entry for moving in records that lived elsewhere; otherwise it is the same as
/// [`create_draft_note`] (the naming, the one-second step when the same second is taken, and the
/// frontmatter all follow core's rules).
///
/// The filename is the creation time itself, that is, the immutable ID, so naming a moved
/// record after "now" loses its original date for good. Pass the time with its own offset
/// declared: the name is decided by that wall clock too.
///
/// When two notes are created in the same second, advance one second at a time until a
/// free second is found. This does not rename anything; it only picks a name nobody uses
/// yet. The frontmatter `time` is aligned to the advanced time too. If the name (list
/// order) and `time` (display) drift apart, order and date disagree within one list.
/// The same holds for a time in the past: imported records sort at their original time,
/// and none of the same-second ones is lost.
///
/// Reservation is left to `create_new`. Checking with `exists()` and then
/// writing lets another thread or process take the same name in between.
/// Creation does not go through `write_atomic` (tmp, then rename): rename
/// silently replaces an existing file, which defeats collision avoidance.
/// A crash mid-write here loses only the half-written new note; existing
/// records are not damaged.
pub fn create_note_at(
    base_dir: &Path,
    time: Stamp,
    body: &str,
    tags: &[String],
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<PathBuf, CoreError> {
    create_kind_at(
        base_dir,
        NoteKind::Note,
        time,
        body,
        tags,
        context,
        provenance,
    )
}

/// IDs are one namespace across both kinds. If the other directory holds
/// the same name, that second counts as taken too, and we advance one second.
/// This side checks with `exists()`, so there is a gap, but only when two
/// directories, two processes and the same second all coincide; the actual
/// damage is picked up by `relocate_duplicate_ids`.
fn create_kind_at(
    base_dir: &Path,
    kind: NoteKind,
    time: Stamp,
    body: &str,
    tags: &[String],
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<PathBuf, CoreError> {
    let mut time = time;
    let mut file_path = kind.file_path(base_dir, time);
    ensure_dir(&file_path)?;

    loop {
        if !exists(&kind.other().file_path(base_dir, time))
            && create_new_with(&file_path, || {
                format_note_markdown(body, tags, time, context, provenance)
            })?
        {
            return Ok(file_path);
        }
        time = time.plus_seconds(1);
        file_path = kind.file_path(base_dir, time);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::note::{
        NoteFilename, list_notes, read_note, read_note_by_filename, read_note_meta,
    };
    use crate::utils::clock::WallClock;
    use crate::utils::device::Source;
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
            sample_time().plus_seconds(1)
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
        assert_eq!(stamp_of(&first).plus_seconds(1), stamp_of(&second));
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
            meta.time.id_stem(),
            second.file_stem().unwrap().to_str().unwrap()
        );
    }

    fn stamp_of(path: &Path) -> WallClock {
        let stem = path.file_stem().unwrap().to_str().unwrap();
        WallClock::parse_id_stem(stem).unwrap()
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

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn sample_time() -> Stamp {
        Stamp::new(2026, 5, 3, 15, 39, 0, 9 * 3600).unwrap()
    }

    fn promoted_from(origin: &str) -> Provenance<'_> {
        Provenance {
            origin: Some(origin),
            ..Provenance::default()
        }
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
}
