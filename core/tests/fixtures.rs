//! `fixtures/` が本物のデータディレクトリとして通用することを確かめる。
//!
//! あの木は `just sandbox` が展開して人が触るものなので、形式が変わったのに
//! 置き去りになっていると、次に開いた人が「アプリが壊れた」と読む。壊れたのは
//! 見本のほうだと CI が先に言う。
//!
//! 読むだけでなく書き込みまで通すのは、fixtures を「parse できる Markdown の
//! 山」ではなく「そこから続きを書けるデータディレクトリ」として検査するため。
//! そのために毎回 temp へ写す — 元の木は 1 バイトも動かさない。

// 落ちることがテストの仕事。握り潰す道を証明しなければならないのは本番の
// コードだけ(`core/src/lib.rs` の同じ断り書きと揃えてある)。
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};

use assert_fs::TempDir;
use assert_fs::prelude::*;
use chrono::NaiveDate;
use magical_merchant_core::{
    DeviceContext, NoteFilename, NoteKind, Revision, Source, list_note_versions, list_notes,
    list_scrawl_dates, list_templates, note_version_status, read_note_by_filename, read_note_meta,
    read_note_version, read_scrawl, read_template, save_scrawl_entry, update_note,
};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("core/ has a parent")
        .join("fixtures")
}

/// fixtures を写した、書き換えてよいデータディレクトリ。
fn sandbox() -> TempDir {
    let temp = TempDir::new().expect("temp dir");
    temp.copy_from(fixtures(), &["**/*"])
        .expect("copy fixtures");
    temp
}

fn filename(name: &str) -> NoteFilename {
    NoteFilename::parse(name).expect("fixture filename is valid")
}

#[test]
fn every_note_in_the_fixtures_can_be_read() {
    let dir = sandbox();
    let notes = list_notes(dir.path()).expect("list");

    assert!(notes.len() >= 7, "fixtures should cover several notes");
    for note in &notes {
        let name = filename(&note.filename);
        read_note_by_filename(dir.path(), &name).expect("body reads");
        read_note_meta(dir.path(), &name).expect("frontmatter parses");
        assert!(note.time.is_some(), "{} has no time", note.filename);
    }
}

/// 本文の 1 行目は必ず `# 見出し`。それがタイトル欄に出る文字そのもので
/// (`note-title.ts`)、frontmatter との間に空行が 1 つ入るだけでタイトルが
/// 空になり、見出しが本文に居座る。Markdown の整形器にかけると入る類の差なので、
/// 見本のほうで止める。
#[test]
fn every_note_body_opens_with_its_title() {
    let dir = sandbox();

    for note in list_notes(dir.path()).expect("list") {
        let body = read_note_by_filename(dir.path(), &filename(&note.filename)).expect("body");
        assert!(
            body.starts_with("# "),
            "{} does not open with its title: {:?}",
            note.filename,
            body.lines().next()
        );
    }
}

/// 一覧が種別・表示モード・出自を拾えるところまで見る。どれか 1 つでも
/// 落ちていれば、その面の画面が空になる。
#[test]
fn the_fixtures_cover_every_kind_of_note() {
    let dir = sandbox();
    let notes = list_notes(dir.path()).expect("list");

    let codex = notes.iter().filter(|n| n.kind == NoteKind::Codex).count();
    assert_eq!(codex, 1, "one Codex");

    assert!(
        notes.iter().any(|n| n.view.as_deref() == Some("preview")),
        "a read-only note"
    );
    assert!(
        notes.iter().any(|n| n.view.as_deref() == Some("mindmap")),
        "a note laid out as a map"
    );
    assert!(
        notes.iter().any(|n| n.origin.is_some()),
        "a note grown from an entry"
    );
    assert!(
        notes.iter().any(|n| n.template.as_deref() == Some("daily")),
        "a note made from a template"
    );
    assert!(
        notes.iter().any(|n| n.tags.iter().any(|t| t == "design")),
        "tags reach the list"
    );
}

#[test]
fn the_codex_has_versions_and_a_draft_that_moved_on() {
    let dir = sandbox();
    let codex = filename("20260701_090000.md");

    let versions = list_note_versions(dir.path(), &codex).expect("versions");
    assert_eq!(versions.len(), 3);
    assert!(
        versions.iter().any(|v| v.message.is_some()),
        "one version carries a message"
    );
    for version in &versions {
        read_note_version(dir.path(), &codex, &version.id).expect("version body reads");
    }

    let status = note_version_status(dir.path(), &codex).expect("status");
    assert_eq!(status.count, 3);
    assert!(status.dirty, "the draft has grown past the latest version");
}

#[test]
fn every_scrawl_day_parses_into_entries() {
    let dir = sandbox();
    let dates = list_scrawl_dates(dir.path()).expect("dates");

    assert_eq!(dates.len(), 2, "two days of entries");
    for date in dates {
        let entries = read_scrawl(dir.path(), date).expect("day reads");
        assert!(!entries.is_empty(), "{date} has entries");
    }

    // 端末の記録が畳まれている日は、読み出しで 1 行ずつに戻る
    let busy = read_scrawl(
        dir.path(),
        NaiveDate::from_ymd_opt(2026, 8, 1).expect("date"),
    )
    .expect("day reads");
    assert!(
        busy.iter().any(|line| line.contains("\"os\":\"android\"")),
        "the phone's entries keep their device"
    );
}

#[test]
fn every_template_can_be_read() {
    let dir = sandbox();
    let templates = list_templates(dir.path()).expect("templates");

    assert!(templates.len() >= 3);
    for template in &templates {
        read_template(dir.path(), &filename(&template.filename)).expect("template reads");
    }
    assert!(
        templates.iter().any(|t| t.name == "daily"),
        "the daily template is there to show the variables"
    );
}

/// 読めるだけでは足りない。そこから書き続けられて初めてデータディレクトリ。
#[test]
fn the_fixtures_can_be_written_to() {
    let dir = sandbox();
    let context = DeviceContext::default();

    save_scrawl_entry(dir.path(), "a new entry", &context, Source::Cli).expect("entry saved");
    let today = chrono::Local::now().date_naive();
    let entries = read_scrawl(dir.path(), today).expect("today reads");
    assert!(entries.iter().any(|line| line.contains("a new entry")));

    let notes = list_notes(dir.path()).expect("list");
    let note = notes
        .iter()
        .find(|n| n.filename == "20260801_093000.md")
        .expect("the plain note");
    let body = read_note_by_filename(dir.path(), &filename(&note.filename)).expect("body");
    // 読んだときの revision を添える。core はこれが合わないと書かせない
    let revision = Revision::of(&body);
    update_note(
        &note.path,
        &format!("{}\n\nAnd a line written later.\n", body.trim_end()),
        &context,
        Some(&revision),
    )
    .expect("the note takes an edit");
}
