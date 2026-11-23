//! The commands a Note's list, viewer and writing screen call.

use magical_merchant_core::domain::device::{ClientContext, probe_with_client};
use magical_merchant_core::utils::clock::Stamp;
use magical_merchant_core::{
    NoteFilename, NoteKind, NoteMeta, NoteSummary, Provenance, Revision, Source,
};
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use crate::services::core_location;
use crate::services::tauri::{app_base_dir, off_main_thread};
use crate::services::widgets;

/// `kind` names the directory: `codex` creates a document that keeps committed
/// versions. Left out, it is an ordinary note.
///
/// It answers the new note's ID (its filename), the name every other note command
/// takes; where the file lives on disk is no business of the screen's.
#[tauri::command]
pub(crate) fn create_draft<R: Runtime>(
    handle: AppHandle<R>,
    body: String,
    tags: Vec<String>,
    client: ClientContext,
    origin: Option<String>,
    kind: Option<NoteKind>,
) -> Result<String, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let context = probe_with_client(client, core_location::latest);
    // With an origin it is a promotion from a Scrawl entry. Record where it came
    // from in the frontmatter
    let provenance = Provenance {
        origin: origin.as_deref(),
        source: Some(Source::App),
        ..Provenance::default()
    };
    magical_merchant_core::create_draft(
        &base_dir,
        kind.unwrap_or(NoteKind::Note),
        &body,
        &tags,
        &context,
        provenance,
    )
    .map(|filename| filename.as_str().to_string())
    .map_err(CommandError::from)
}

/// `revision` is the fingerprint of the body `read_note` returned.
///
/// The write is refused as `stale` if the CLI or MCP rewrote the same note in
/// between. What comes back is the revision of the body just written: supply that
/// on the next save.
///
/// It is required, unlike core's `expected`. Without one core checks nothing and the
/// body lands on whatever the disk holds, which nobody on the screen has read; every
/// body the app shows comes from `read_note`, so it always has one to send.
///
/// It takes the ID (the filename) only and asks core for the directory. Writing an
/// absolute path handed over from the `WebView` as it is would also allow writes
/// outside `data/`, and onto the traces of deleted notes and of notes turned into a
/// Codex.
// AIDEV-NOTE: the ID goes to core, which finds the directory, as for the other note commands. Do not go back to taking a path
#[tauri::command]
pub(crate) fn update_draft<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    body: String,
    client: ClientContext,
    revision: String,
) -> Result<String, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    let context = probe_with_client(client, core_location::latest);
    let expected = Revision::from(revision);
    magical_merchant_core::update_note(&base_dir, &filename, &body, &context, Some(&expected))
        .map(|r| r.to_string())
        .map_err(CommandError::from)
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct NoteRead {
    pub(crate) body: String,
    /// Fingerprint of the body. Supply it to `update_draft` so a write from
    /// outside is not written over.
    pub(crate) revision: String,
}

/// Clean-up that runs once per launch, before the first listing.
///
/// It is not done in `setup` because Android's `app_data_dir` cannot be called from
/// the main thread, and to keep a listing from before the repair off the screen even
/// for a moment. Either one failing is passed over silently: that beats leaving
/// notes unreadable, and the next launch tries again.
///
/// This is not repair for the sake of sync. The engine does that inside
/// `.sync.lock` (`core/src/domain/sync/run.rs`). What stays here is so that the listing
/// does not show broken notes even for someone who never syncs.
///
/// AIDEV-NOTE: this one at startup is outside the lock. The window where it overlaps the CLI's sync remains. To close it, `try_lock` and skip when it cannot be taken
pub(crate) fn repair_once(base_dir: &std::path::Path) {
    static REPAIR: std::sync::Once = std::sync::Once::new();
    REPAIR.call_once(|| {
        // `data/timeline/`, from before the rename
        let _ = magical_merchant_core::migrate_scrawl_dir(base_dir);
        // Garbled metadata that past edits mixed into the body
        let _ = magical_merchant_core::repair_notes(base_dir);
        // Conflict copies an older version of the app put in `data/`
        let _ = magical_merchant_core::relocate_conflict_copies(base_dir);
        // The same ID that came down into both `notes/` and `codex/` because a
        // promotion overlapped with an offline edit on another device
        let _ = magical_merchant_core::relocate_duplicate_ids(base_dir);
    });
}

#[tauri::command]
pub(crate) async fn list_notes<R: Runtime>(
    handle: AppHandle<R>,
) -> Result<Vec<NoteSummary>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        repair_once(&base_dir);

        magical_merchant_core::list_notes(&base_dir).map_err(CommandError::from)
    })
    .await
}

#[tauri::command]
pub(crate) fn read_note<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<NoteRead, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    let opened = magical_merchant_core::open_note(&base_dir, &filename)?;
    Ok(NoteRead {
        body: opened.body,
        revision: opened.revision.to_string(),
    })
}

#[tauri::command]
pub(crate) fn read_note_meta<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<NoteMeta, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::read_note_meta(&base_dir, &filename).map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn update_note_meta<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    time: String,
    tags: Vec<String>,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    // Take RFC 3339 with an offset. With a bare date and time, the same input would
    // point at a different instant as soon as the device time zone changed
    let time = Stamp::parse_strict(&time)?;
    magical_merchant_core::update_note_meta(&base_dir, &filename, time, &tags)
        .map_err(CommandError::from)
}

/// Rewrites the view mode only. `None` goes back to the default (the editor).
#[tauri::command]
pub(crate) fn set_note_view<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    view: Option<String>,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::update_note_view(&base_dir, &filename, view.as_deref())
        .map_err(CommandError::from)
}

/// Rewrites only the link to the entry it was promoted from. `None` unties it.
#[tauri::command]
pub(crate) fn set_note_origin<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    origin: Option<String>,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::update_note_origin(&base_dir, &filename, origin.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn delete_note<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::delete_note(&base_dir, &filename)?;
    // A template's {{prev}} may have pointed at the deleted note
    widgets::refresh_templates();
    Ok(())
}

/// What the webview gets back, called through a mock app over a temporary data directory.
#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "a test app holds the data directory until the test ends"
)]
mod tests {
    use magical_merchant_core::utils::clock::WallClock;

    use super::*;
    use crate::commands::codex::promote_note_to_codex;
    use crate::test_app::{TestApp, test_app};

    fn client() -> ClientContext {
        ClientContext::default()
    }

    fn create(app: &TestApp, body: &str, kind: Option<NoteKind>) -> String {
        create_draft(app.handle(), body.to_string(), vec![], client(), None, kind).unwrap()
    }

    fn read(app: &TestApp, filename: &str) -> NoteRead {
        read_note(app.handle(), filename.to_string()).unwrap()
    }

    fn update(
        app: &TestApp,
        filename: &str,
        body: &str,
        revision: &str,
    ) -> Result<String, CommandError> {
        update_draft(
            app.handle(),
            filename.to_string(),
            body.to_string(),
            client(),
            revision.to_string(),
        )
    }

    /// The screen opens what it made by the ID alone, as every other note command takes it.
    #[test]
    fn create_draft_makes_a_note_and_answers_its_id() {
        let app = test_app();

        let answer = create(&app, "body", None);

        assert!(!answer.contains('/'), "{answer}");
        let stem = answer.strip_suffix(".md").unwrap();
        assert!(WallClock::parse_id_stem(stem).is_ok(), "{answer}");
        assert!(app.base().join("data/notes").join(&answer).exists());
    }

    #[test]
    fn create_draft_of_a_codex_puts_it_under_codex() {
        let app = test_app();

        let answer = create(&app, "body", Some(NoteKind::Codex));

        assert!(app.base().join("data/codex").join(&answer).exists());
    }

    #[test]
    fn create_draft_records_the_origin_and_that_the_app_wrote_it() {
        let app = test_app();

        let answer = create_draft(
            app.handle(),
            "from an entry".to_string(),
            vec![],
            client(),
            Some("2026-08-13T08:30:00".to_string()),
            None,
        )
        .unwrap();

        let filename = NoteFilename::parse(&answer).unwrap();
        let meta = magical_merchant_core::read_note_meta(app.base(), &filename).unwrap();
        assert_eq!(meta.origin.as_deref(), Some("2026-08-13T08:30:00"));
        assert_eq!(meta.source.as_deref(), Some("app"));
    }

    #[test]
    fn read_note_answers_the_body_and_its_revision() {
        let app = test_app();
        let filename = create(&app, "# Title\nbody", None);

        let read = read(&app, &filename);

        assert_eq!(read.body, "# Title\nbody");
        assert_eq!(read.revision, Revision::of("# Title\nbody").to_string());
        let json = serde_json::to_value(&read).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["body", "revision"]);
    }

    #[test]
    fn update_draft_with_the_read_revision_writes_and_answers_the_next_one() {
        let app = test_app();
        let filename = create(&app, "before", None);
        let revision = read(&app, &filename).revision;

        let next = update(&app, &filename, "after", &revision).unwrap();

        assert_eq!(next, Revision::of("after").to_string());
        assert_eq!(read(&app, &filename).body, "after");
    }

    #[test]
    fn update_draft_with_an_old_revision_is_refused_as_stale() {
        let app = test_app();
        let filename = create(&app, "before", None);
        let old = read(&app, &filename).revision;
        update(&app, &filename, "theirs", &old).unwrap();

        let refused = update(&app, &filename, "mine", &old).unwrap_err();

        assert_eq!(refused.kind, "stale");
        assert_eq!(read(&app, &filename).body, "theirs");
    }

    #[test]
    fn update_draft_of_a_deleted_note_is_refused_as_missing() {
        let app = test_app();
        let filename = create(&app, "before", None);
        let revision = read(&app, &filename).revision;
        delete_note(app.handle(), filename.clone()).unwrap();

        let refused = update(&app, &filename, "after", &revision).unwrap_err();

        assert_eq!(refused.kind, "missing");
        assert!(!app.base().join("data/notes").join(&filename).exists());
    }

    #[test]
    fn update_draft_of_a_promoted_note_writes_where_the_codex_lives() {
        let app = test_app();
        let filename = create(&app, "before", None);
        let revision = read(&app, &filename).revision;
        promote_note_to_codex(app.handle(), filename.clone()).unwrap();

        update(&app, &filename, "after", &revision).unwrap();

        assert!(app.base().join("data/codex").join(&filename).exists());
        assert!(!app.base().join("data/notes").join(&filename).exists());
        assert_eq!(read(&app, &filename).body, "after");
    }

    #[test]
    fn update_draft_of_a_name_that_is_no_note_is_other() {
        let app = test_app();

        let refused = update(&app, "../escape.md", "body", "rev").unwrap_err();

        assert_eq!(refused.kind, "other");
    }

    #[test]
    fn a_save_error_crosses_as_its_kind_and_message() {
        let app = test_app();

        let refused = update(&app, "../escape.md", "body", "rev").unwrap_err();

        let json = serde_json::to_value(&refused).unwrap();
        let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["kind", "message"]);
        assert_eq!(json["kind"], "other");
    }

    #[test]
    fn update_note_meta_takes_a_time_with_an_offset() {
        let app = test_app();
        let filename = create(&app, "body", None);

        update_note_meta(
            app.handle(),
            filename.clone(),
            "2026-01-01T10:00:00+09:00".to_string(),
            vec!["tag".to_string()],
        )
        .unwrap();

        let meta = read_note_meta(app.handle(), filename).unwrap();
        assert_eq!(meta.time.rfc3339(), "2026-01-01T10:00:00+09:00");
        assert_eq!(meta.tags, ["tag"]);
    }

    #[test]
    fn update_note_meta_refuses_a_time_without_an_offset_as_other() {
        let app = test_app();
        let filename = create(&app, "body", None);
        let before = read_note_meta(app.handle(), filename.clone()).unwrap();

        let refused = update_note_meta(
            app.handle(),
            filename.clone(),
            "2026-01-01T10:00:00".to_string(),
            vec![],
        )
        .unwrap_err();

        assert_eq!(refused.kind, "other");
        assert!(!refused.message.is_empty());
        assert_eq!(
            read_note_meta(app.handle(), filename).unwrap().time,
            before.time
        );
    }

    /// Every command now refuses with a kind: reading a note that is gone says so.
    #[test]
    fn read_note_of_a_deleted_note_is_refused_as_missing() {
        let app = test_app();
        let filename = create(&app, "body", None);
        delete_note(app.handle(), filename.clone()).unwrap();

        let refused = read_note(app.handle(), filename).unwrap_err();

        assert_eq!(refused.kind, "missing");
    }
}
