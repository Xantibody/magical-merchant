//! The bodies of `list` / `show` / `edit` / `new` / `import`. Launching the editor comes in
//! as an argument, and the tests pass in a closure that rewrites the file.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local};
use magical_merchant_core::{CoreError, NoteFilename, NoteSummary, Provenance, Revision, Source};

use crate::notes::{self, WriteError};

/// The scratch file handed to the editor. When the edit is not accepted it is left in
/// place: better to name where it is and let the user pick it up than to lose what was
/// typed.
pub(crate) fn scratch_dir() -> PathBuf {
    std::env::temp_dir().join("magical-merchant")
}

// --- list / show ---

#[derive(Debug)]
pub(crate) struct Row {
    pub(crate) filename: String,
    pub(crate) time: String,
    pub(crate) title: String,
    pub(crate) tags: Vec<String>,
}

/// The list takes the body's first line as the title. The same rule as the app's list.
fn title_of(summary: &NoteSummary) -> String {
    summary
        .preview
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim()
        .to_string()
}

pub(crate) fn list(data_dir: &Path) -> Result<Vec<Row>, CoreError> {
    let notes = magical_merchant_core::list_notes(data_dir)?;
    Ok(notes
        .iter()
        .map(|n| Row {
            filename: n.filename.clone(),
            time: n
                .time
                .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_default(),
            title: title_of(n),
            tags: n.tags.clone(),
        })
        .collect())
}

pub(crate) fn show(data_dir: &Path, filename: &NoteFilename) -> Result<String, CoreError> {
    Ok(notes::read(data_dir, filename)?.body)
}

/// Accepts either `20260320_143045` or `20260320_143045.md`. The newest when omitted.
pub(crate) fn resolve(data_dir: &Path, arg: Option<&str>) -> Result<NoteFilename, CoreError> {
    let Some(text) = arg else {
        let notes = magical_merchant_core::list_notes(data_dir)?;
        let newest = notes
            .first()
            .ok_or_else(|| CoreError::NotFound("no notes yet".to_string()))?;
        return NoteFilename::parse(&newest.filename);
    };
    // Only the lowercase `.md` extension is an ID. `.MD` is a different filename, so it is
    // not completed
    let with_ext = text
        .strip_suffix(".md")
        .map_or_else(|| format!("{text}.md"), |_| text.to_string());
    NoteFilename::parse(&with_ext)
}

// --- edit ---

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EditOutcome {
    /// The editor closed but the body is the same. Nothing is written: a write that does
    /// not change the content only moves the mtime and sets off a sync.
    Unchanged,
    Saved {
        snapshot_id: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum EditError {
    #[error("{reason}\nyour edit is kept at {}", kept.display())]
    Refused { reason: WriteError, kept: PathBuf },
    #[error("{reason}\nyour edit is kept at {}", kept.display())]
    Editor { reason: String, kept: PathBuf },
    #[error(transparent)]
    Core(#[from] CoreError),
}

/// Writes the body alone to a scratch file, opens it in the editor, and writes it back if
/// it changed.
///
/// The frontmatter is not shown. Showing it lets it be broken by hand, and an unknown key
/// is dropped on the next save. The title is the body's first line, so the body is enough.
pub(crate) fn edit(
    data_dir: &Path,
    filename: &NoteFilename,
    scratch: &Path,
    open: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<EditOutcome, EditError> {
    let before = notes::read(data_dir, filename)?;
    let scratch_file = scratch.join(filename.as_str());
    fs::create_dir_all(scratch).map_err(CoreError::from)?;
    fs::write(&scratch_file, &before.body).map_err(CoreError::from)?;

    if let Err(e) = open(&scratch_file) {
        return Err(EditError::Editor {
            reason: e,
            kept: scratch_file,
        });
    }
    let after = fs::read_to_string(&scratch_file).map_err(CoreError::from)?;
    if Revision::of(&after) == before.revision {
        let _ = fs::remove_file(&scratch_file);
        return Ok(EditOutcome::Unchanged);
    }

    match notes::overwrite(data_dir, filename, &after, Some(&before.revision)) {
        Ok(written) => {
            let _ = fs::remove_file(&scratch_file);
            Ok(EditOutcome::Saved {
                snapshot_id: written.snapshot.id,
            })
        }
        Err(e) => Err(EditError::Refused {
            reason: e,
            kept: scratch_file,
        }),
    }
}

// --- new ---

/// Turns the body straight into a note. Creates nothing when it is empty.
pub(crate) fn create(data_dir: &Path, body: &str) -> Result<Option<NoteFilename>, CoreError> {
    notes::create(
        data_dir,
        body,
        &[],
        Provenance {
            source: Some(Source::Cli),
            ..Provenance::default()
        },
    )
}

// --- import ---

/// Takes in a note written elsewhere, keeping the time it was written. Creates nothing
/// when it is empty.
///
/// Only the time and the origin set it apart from `new`: the body and the frontmatter go
/// through the same path (`notes::create_at`). Whatever Obsidian or anything else needs
/// belongs to the caller, a throwaway script, and does not come in here.
pub(crate) fn import(
    data_dir: &Path,
    time: DateTime<FixedOffset>,
    body: &str,
    tags: &[String],
    template: Option<&str>,
) -> Result<Option<NoteFilename>, CoreError> {
    notes::create_at(
        data_dir,
        time,
        body,
        tags,
        Provenance {
            source: Some(Source::Import),
            template,
            ..Provenance::default()
        },
    )
}

/// Opens a scratch file holding only `seed` in the editor and returns the whole text if
/// anything was written. `None` when it is still empty or still the seed. Creating the
/// record before opening would leave an empty record behind when the editor is merely
/// closed, so the record is created only after something is written.
pub(crate) fn write_in_editor(
    scratch: &Path,
    name: &str,
    seed: &str,
    open: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Option<String>, EditError> {
    fs::create_dir_all(scratch).map_err(CoreError::from)?;
    let scratch_file = scratch.join(format!(
        "{name}-{}.md",
        Local::now().format("%Y%m%d_%H%M%S")
    ));
    fs::write(&scratch_file, seed).map_err(CoreError::from)?;

    if let Err(e) = open(&scratch_file) {
        return Err(EditError::Editor {
            reason: e,
            kept: scratch_file,
        });
    }
    let text = fs::read_to_string(&scratch_file).map_err(CoreError::from)?;
    let _ = fs::remove_file(&scratch_file);
    if text.trim().is_empty() || text == seed {
        return Ok(None);
    }
    Ok(Some(text))
}

/// Opens an empty scratch file (or one holding only a `# Title`) in the editor and turns
/// it into a note if anything was written.
pub(crate) fn compose(
    data_dir: &Path,
    scratch: &Path,
    seed: &str,
    open: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Option<NoteFilename>, EditError> {
    match write_in_editor(scratch, "new", seed, open)? {
        Some(body) => Ok(create(data_dir, &body)?),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use magical_merchant_core::utils::device::Context;
    use tempfile::TempDir;

    fn seed(base: &Path, body: &str) -> NoteFilename {
        let path = magical_merchant_core::create_draft_note(
            base,
            body,
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn body_of(base: &Path, filename: &NoteFilename) -> String {
        magical_merchant_core::read_note_by_filename(base, filename).unwrap()
    }

    fn typing(text: &'static str) -> impl FnOnce(&Path) -> Result<(), String> {
        move |path| fs::write(path, text).map_err(|e| e.to_string())
    }

    #[test]
    fn the_list_shows_the_first_line_as_the_title_without_the_hash() {
        let tmp = TempDir::new().unwrap();
        seed(tmp.path(), "# Groceries\n\nmilk #home");

        let rows = list(tmp.path()).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Groceries");
        assert_eq!(rows[0].tags, vec!["home"]);
        assert!(NoteFilename::parse(&rows[0].filename).is_ok());
    }

    #[test]
    fn a_stem_resolves_to_the_note_and_nothing_resolves_to_the_newest() {
        let tmp = TempDir::new().unwrap();
        let first = seed(tmp.path(), "first");
        let stem = first.as_str().trim_end_matches(".md").to_string();

        assert_eq!(resolve(tmp.path(), Some(&stem)).unwrap(), first);
        assert_eq!(resolve(tmp.path(), Some(first.as_str())).unwrap(), first);
        assert_eq!(resolve(tmp.path(), None).unwrap(), first);
        assert!(resolve(TempDir::new().unwrap().path(), None).is_err());
    }

    #[test]
    fn the_editor_sees_the_body_only_and_the_result_is_written_back() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "# T\nbefore");
        let scratch = tmp.path().join("scratch");

        let outcome = edit(tmp.path(), &filename, &scratch, |path| {
            let shown = fs::read_to_string(path).unwrap();
            assert_eq!(shown, "# T\nbefore", "no frontmatter in the editor");
            fs::write(path, "# T\nafter").unwrap();
            Ok(())
        })
        .unwrap();

        assert!(matches!(outcome, EditOutcome::Saved { .. }));
        assert_eq!(body_of(tmp.path(), &filename), "# T\nafter");
        assert!(
            !scratch.join(filename.as_str()).exists(),
            "an accepted edit leaves no scratch file behind"
        );
        let content =
            fs::read_to_string(tmp.path().join("data/notes").join(filename.as_str())).unwrap();
        assert!(content.starts_with("---\n"), "frontmatter survives");
    }

    #[test]
    fn closing_the_editor_without_changes_writes_nothing() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "same");
        let before =
            fs::read_to_string(tmp.path().join("data/notes").join(filename.as_str())).unwrap();

        let outcome = edit(tmp.path(), &filename, &tmp.path().join("scratch"), |_| {
            Ok(())
        })
        .unwrap();

        assert_eq!(outcome, EditOutcome::Unchanged);
        let after =
            fs::read_to_string(tmp.path().join("data/notes").join(filename.as_str())).unwrap();
        assert_eq!(after, before, "not even `updated` moves");
    }

    /// The app saved the same note while the editor was open. Nothing is written over it,
    /// and what was typed stays in the scratch file.
    #[test]
    fn an_edit_that_raced_another_writer_is_refused_and_kept() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "before");
        let scratch = tmp.path().join("scratch");
        let note_path = tmp.path().join("data/notes").join(filename.as_str());

        let err = edit(tmp.path(), &filename, &scratch, |path| {
            magical_merchant_core::update_note(&note_path, "the app", &Context::default(), None)
                .unwrap();
            fs::write(path, "mine").unwrap();
            Ok(())
        })
        .unwrap_err();

        let EditError::Refused {
            reason: WriteError::Stale(_),
            kept,
        } = err
        else {
            panic!("expected a stale refusal, got {err}");
        };
        assert_eq!(fs::read_to_string(kept).unwrap(), "mine");
        assert_eq!(body_of(tmp.path(), &filename), "the app");
    }

    #[test]
    fn emptying_a_note_in_the_editor_is_refused() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "keep me");

        let err = edit(
            tmp.path(),
            &filename,
            &tmp.path().join("scratch"),
            typing("\n\n"),
        )
        .unwrap_err();

        assert!(matches!(
            err,
            EditError::Refused {
                reason: WriteError::Empty,
                ..
            }
        ));
        assert_eq!(body_of(tmp.path(), &filename), "keep me");
    }

    #[test]
    fn a_failing_editor_keeps_the_note_and_the_scratch_file() {
        let tmp = TempDir::new().unwrap();
        let filename = seed(tmp.path(), "keep me");
        let scratch = tmp.path().join("scratch");

        let err = edit(tmp.path(), &filename, &scratch, |_| {
            Err("vi exited with 1".to_string())
        })
        .unwrap_err();

        assert!(matches!(err, EditError::Editor { .. }));
        assert!(scratch.join(filename.as_str()).exists());
        assert_eq!(body_of(tmp.path(), &filename), "keep me");
    }

    #[test]
    fn composing_creates_a_note_only_when_something_was_written() {
        let tmp = TempDir::new().unwrap();
        let scratch = tmp.path().join("scratch");

        let none = compose(tmp.path(), &scratch, "", |_| Ok(())).unwrap();
        let untouched = compose(tmp.path(), &scratch, "# \n\n", |_| Ok(())).unwrap();
        let some = compose(tmp.path(), &scratch, "", typing("# Idea\n\nbody")).unwrap();

        assert_eq!(none, None);
        assert_eq!(untouched, None);
        let filename = some.unwrap();
        assert_eq!(body_of(tmp.path(), &filename), "# Idea\n\nbody");
        assert_eq!(list(tmp.path()).unwrap().len(), 1);
    }

    #[test]
    fn creating_from_a_body_skips_blank_input() {
        let tmp = TempDir::new().unwrap();

        assert_eq!(create(tmp.path(), "  \n").unwrap(), None);
        let filename = create(tmp.path(), "from stdin").unwrap().unwrap();
        assert_eq!(body_of(tmp.path(), &filename), "from stdin");
    }

    fn written_at(text: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(text).unwrap()
    }

    /// A note moved in keeps the time it was written. Filename = creation time = ID, so
    /// naming it "now" here would make the original date unrecoverable.
    #[test]
    fn an_imported_note_keeps_the_time_it_was_written_at() {
        let tmp = TempDir::new().unwrap();

        let filename = import(
            tmp.path(),
            written_at("2019-05-04T12:00:00+09:00"),
            "# 昔のメモ\n\n本文",
            &["memo".to_string()],
            None,
        )
        .unwrap()
        .unwrap();

        assert_eq!(filename.as_str(), "20190504_120000.md");
        let meta = magical_merchant_core::read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, written_at("2019-05-04T12:00:00+09:00"));
        assert_eq!(meta.tags, vec!["memo"]);
        assert_eq!(body_of(tmp.path(), &filename), "# 昔のメモ\n\n本文");
    }

    /// The origin is `import`, not `cli`. This record is the only thing that can pick out
    /// what was moved in later, and the template name can only be written at creation.
    #[test]
    fn an_imported_note_names_import_and_its_template() {
        let tmp = TempDir::new().unwrap();

        let filename = import(
            tmp.path(),
            written_at("2026-01-14T00:00:00+09:00"),
            "# 2026-01-14",
            &[],
            Some("journal"),
        )
        .unwrap()
        .unwrap();

        let meta = magical_merchant_core::read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.source, Some("import".to_string()));
        assert_eq!(meta.template, Some("journal".to_string()));
    }

    /// Two records written at the same time never cost one of them.
    #[test]
    fn two_imports_of_the_same_time_both_land() {
        let tmp = TempDir::new().unwrap();
        let at = |body| {
            import(
                tmp.path(),
                written_at("2019-05-04T12:00:00+09:00"),
                body,
                &[],
                None,
            )
            .unwrap()
            .unwrap()
        };

        let first = at("one");
        let second = at("two");

        assert_eq!(first.as_str(), "20190504_120000.md");
        assert_eq!(second.as_str(), "20190504_120001.md");
        assert_eq!(list(tmp.path()).unwrap().len(), 2);
    }

    /// An empty file does not become a note. As with `new`, no empty record is left.
    #[test]
    fn importing_an_empty_body_creates_nothing() {
        let tmp = TempDir::new().unwrap();

        assert_eq!(
            import(
                tmp.path(),
                written_at("2019-05-04T12:00:00+09:00"),
                "  \n",
                &[],
                None
            )
            .unwrap(),
            None
        );
        assert!(list(tmp.path()).unwrap().is_empty());
    }
}
