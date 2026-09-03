//! `list` / `show` / `edit` / `new` の中身。エディタの起動は引数で受け取り、
//! テストでは「ファイルを書き換える閉包」を差し込む。

use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use magical_merchant_core::{CoreError, NoteFilename, NoteSummary, Provenance, Revision, Source};

use crate::notes::{self, WriteError};

/// エディタに渡す一時ファイル。編集が受け付けられなかったときは消さずに
/// 残す — 書いた字を失うより、置き場を伝えて拾ってもらうほうがいい。
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

/// 一覧は本文の 1 行目をタイトルにする。アプリの一覧と同じ規則。
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

/// `20260320_143045` でも `20260320_143045.md` でも通す。省略なら最新。
pub(crate) fn resolve(data_dir: &Path, arg: Option<&str>) -> Result<NoteFilename, CoreError> {
    let Some(text) = arg else {
        let notes = magical_merchant_core::list_notes(data_dir)?;
        let newest = notes
            .first()
            .ok_or_else(|| CoreError::NotFound("no notes yet".to_string()))?;
        return NoteFilename::parse(&newest.filename);
    };
    // 拡張子は小文字の `.md` だけが ID。`.MD` は別のファイル名なので補わない
    let with_ext = text
        .strip_suffix(".md")
        .map_or_else(|| format!("{text}.md"), |_| text.to_string());
    NoteFilename::parse(&with_ext)
}

// --- edit ---

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EditOutcome {
    /// エディタを閉じたが本文は同じ。何も書かない — 書いても内容が
    /// 変わらないなら、mtime を動かして同期を起こすだけ。
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

/// 本文だけを一時ファイルに出してエディタで開き、変わっていれば書き戻す。
///
/// frontmatter は見せない。見せると手で崩せてしまい、未知のキーは次の
/// 保存で落ちる。タイトルは本文の 1 行目なので、本文だけで足りる。
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

/// 本文をそのままノートにする。空なら作らない。
pub(crate) fn create(data_dir: &Path, body: &str) -> Result<Option<NoteFilename>, CoreError> {
    if body.trim().is_empty() {
        return Ok(None);
    }
    let path = magical_merchant_core::create_draft_note(
        data_dir,
        body,
        &[],
        &notes::context(),
        Provenance {
            source: Some(Source::Cli),
            ..Provenance::default()
        },
    )?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::NotFound(path.display().to_string()))?;
    NoteFilename::parse(name).map(Some)
}

/// `seed` だけの一時ファイルをエディタで開き、何か書かれていればその全文を
/// 返す。空のまま・seed のままなら `None`。先に記録を作ってから開くと、
/// 閉じただけで空の記録が残るので、書かれた後にだけ作る。
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

/// 空(または `# 題` だけ)の一時ファイルをエディタで開き、書かれていれば
/// ノートにする。
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

    /// エディタを開いているあいだにアプリが同じノートを保存した。
    /// その上には書かず、打った字は一時ファイルに残す。
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
}
