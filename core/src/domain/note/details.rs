//! The note panel's details: the record fields a person may change after creation.
//!
//! Only the creation time, the tags, the view and the link to the entry a note came
//! from. The body is the writing screen's, and the context ("which device wrote it")
//! and the source are records nobody edits.

use std::path::Path;

use crate::domain::note::file;
use crate::domain::note::{NoteFilename, NoteFrontmatter, locate_note};
use crate::services::files::{read_text, write_atomic};
use crate::utils::clock::Stamp;
use crate::utils::error::CoreError;

/// Replace only time and tags. The body of course, and context too, are not editable:
/// context is the record of "which device wrote it".
pub fn update_note_meta(
    base_dir: &Path,
    filename: &NoteFilename,
    time: Stamp,
    tags: &[String],
) -> Result<(), CoreError> {
    edit_frontmatter(base_dir, filename, |existing| NoteFrontmatter {
        time,
        tags: tags.to_vec(),
        ..existing
    })
}

/// Replace only the view mode. `None` returns it to the default (editor).
/// time / tags / context / body are not touched.
pub fn update_note_view(
    base_dir: &Path,
    filename: &NoteFilename,
    view: Option<&str>,
) -> Result<(), CoreError> {
    edit_frontmatter(base_dir, filename, |existing| NoteFrontmatter {
        view: view.map(str::to_string),
        ..existing
    })
}

/// Replace only the link to the entry it was promoted from. `None` cuts the link and
/// makes it an independent note again. time / tags / context / body are not touched.
pub fn update_note_origin(
    base_dir: &Path,
    filename: &NoteFilename,
    origin: Option<&str>,
) -> Result<(), CoreError> {
    edit_frontmatter(base_dir, filename, |existing| NoteFrontmatter {
        origin: origin.map(str::to_string),
        ..existing
    })
}

/// Replace part of the frontmatter ([`file::edit_record`]) and write it back.
fn edit_frontmatter<F>(base_dir: &Path, filename: &NoteFilename, edit: F) -> Result<(), CoreError>
where
    F: FnOnce(NoteFrontmatter) -> NoteFrontmatter,
{
    let (_, path) = locate_note(base_dir, filename)?;
    let content = read_text(&path)?;
    write_atomic(&path, file::edit_record(&content, edit)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::{Context, Source};
    use crate::domain::note::{
        NoteKind, Provenance, create_draft, read_note_by_filename, read_note_meta, update_note,
    };
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

    /// A plain new note that declares nothing, and where it was written. Every test except
    /// those about creation itself goes through this, so adding a provenance kind does not
    /// rewrite every test.
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<PathBuf, CoreError> {
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            body,
            tags,
            &mock_context(),
            Provenance::default(),
        )?;
        Ok(NoteKind::Note.dir(tmp.path()).join(filename.as_str()))
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
        update_note(tmp.path(), &filename, "edited", &mock_context(), None).unwrap();
        let stamped = read_note_meta(tmp.path(), &filename).unwrap().updated;

        update_note_meta(tmp.path(), &filename, sample_time(), &[]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().updated,
            stamped
        );
    }

    /// Neither a metadata edit nor a view-mode switch writes the body.
    /// Still less do they touch the creation record.
    #[test]
    fn update_note_meta_and_view_do_not_touch_the_source() {
        let tmp = TempDir::new().unwrap();
        let filename = create_draft(
            tmp.path(),
            NoteKind::Note,
            "body",
            &[],
            &mock_context(),
            Provenance {
                source: Some(Source::Mcp),
                ..Provenance::default()
            },
        )
        .unwrap();

        update_note_meta(tmp.path(), &filename, sample_time(), &["log".to_string()]).unwrap();
        update_note_view(tmp.path(), &filename, Some("mindmap")).unwrap();

        assert_eq!(
            read_note_meta(tmp.path(), &filename).unwrap().source,
            Some("mcp".to_string())
        );
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

        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "# Title\nbody"
        );
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

        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "# Title\nbody"
        );
        let meta = read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, before.time);
        assert_eq!(meta.context.unwrap().battery, Some(50));
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
        create_draft(
            tmp.path(),
            NoteKind::Note,
            "エントリ本文",
            &[],
            &mock_context(),
            promoted_from("2026-08-13T08:30:00"),
        )
        .unwrap()
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
}
