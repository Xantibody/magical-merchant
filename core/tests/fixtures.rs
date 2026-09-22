//! Checks that `fixtures/` passes as a real data directory.
//!
//! That tree is what `just sandbox` unpacks for a person to touch, so if the format changes
//! and it is left behind, the next person to open it reads "the app is broken". CI says
//! first that it is the sample that broke.
//!
//! Writing is exercised, not only reading, because this inspects the fixtures as "a data
//! directory you can keep writing from", not "a pile of Markdown that parses".
//! For that it copies them to temp every time: the original tree does not move by a byte.

// Failing is the test's job. Only production code has to prove its path for a swallowed
// error (aligned with the same disclaimer in `core/src/lib.rs`).
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

/// A writable data directory copied from the fixtures.
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

/// The first line of the body is always `# heading`. That is the exact text shown in the
/// title field (`note-title.ts`); a single blank line between it and the frontmatter leaves
/// the title empty and the heading sitting in the body. A Markdown formatter introduces that
/// kind of difference, so it is stopped at the sample.
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

/// Looks as far as the list picking up kind, view mode, origin, template and tags. If any
/// one of them is missing, that surface's screen is empty.
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

    // A day with folded device records comes back one line at a time on read
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

/// Being readable is not enough. It is a data directory only once you can keep writing from it.
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
    // Attach the revision as read. core refuses the write when it does not match
    let revision = Revision::of(&body);
    update_note(
        &note.path,
        &format!("{}\n\nAnd a line written later.\n", body.trim_end()),
        &context,
        Some(&revision),
    )
    .expect("the note takes an edit");
}
