//! The commands a Codex adds to a Note: turning one into a Codex, and its versions.

use magical_merchant_core::domain::device::{ClientContext, probe_with_client};
use magical_merchant_core::{NoteFilename, Revision, Version, VersionStatus};
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use crate::services::core_location;
use crate::services::tauri::app_base_dir;

/// Turns a Note into a Codex. The ID does not change. There is no way back.
#[tauri::command]
pub(crate) fn promote_note_to_codex<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::promote_note_to_codex(&base_dir, &filename).map_err(CommandError::from)
}

/// Commits the current draft as a version. Called only when a person asks to
/// commit a version.
#[tauri::command]
pub(crate) fn commit_note_version<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    message: Option<String>,
) -> Result<Version, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::commit_note_version(&base_dir, &filename, message.as_deref())
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn list_note_versions<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<Vec<Version>, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::list_note_versions(&base_dir, &filename).map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn read_note_version<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    id: String,
) -> Result<String, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::read_note_version(&base_dir, &filename, &id).map_err(CommandError::from)
}

/// Unified diff from version `from` to the current draft. Two versions are never
/// compared: the screen only shows what changed since this version.
#[tauri::command]
pub(crate) fn diff_note_versions<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    from: String,
) -> Result<String, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::diff_note_versions(&base_dir, &filename, &from, None)
        .map_err(CommandError::from)
}

/// Makes a version's body the draft. `revision` means what it means in
/// `update_draft`, and is required for the same reason; a mismatch is `stale`.
/// Core commits the draft as a version before writing over it.
#[tauri::command]
pub(crate) fn restore_note_version<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    id: String,
    client: ClientContext,
    revision: String,
) -> Result<String, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    let context = probe_with_client(client, core_location::latest);
    let expected = Revision::from(revision);
    magical_merchant_core::restore_note_version(
        &base_dir,
        &filename,
        &id,
        &context,
        Some(&expected),
    )
    .map(|r| r.to_string())
    .map_err(CommandError::from)
}

/// The "undo" right after a commit. It only deletes the version file and does not
/// touch the body.
#[tauri::command]
pub(crate) fn delete_note_version<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
    id: String,
) -> Result<(), CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::delete_note_version(&base_dir, &filename, &id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub(crate) fn note_version_status<R: Runtime>(
    handle: AppHandle<R>,
    filename: String,
) -> Result<VersionStatus, CommandError> {
    let base_dir = app_base_dir(&handle)?;
    let filename = NoteFilename::parse(&filename)?;
    magical_merchant_core::note_version_status(&base_dir, &filename).map_err(CommandError::from)
}

/// What the webview gets back, called through a mock app over a temporary data directory.
#[cfg(test)]
#[allow(
    clippy::significant_drop_tightening,
    reason = "a test app holds the data directory until the test ends"
)]
mod tests {
    use magical_merchant_core::NoteKind;

    use super::*;
    use crate::commands::note::{NoteRead, create_draft, read_note, update_draft};
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

    #[test]
    fn restore_note_version_with_an_old_revision_is_refused_as_stale() {
        let app = test_app();
        let filename = create(&app, "first", Some(NoteKind::Codex));
        let version = commit_note_version(app.handle(), filename.clone(), None).unwrap();
        let old = read(&app, &filename).revision;
        update(&app, &filename, "second", &old).unwrap();

        let refused =
            restore_note_version(app.handle(), filename.clone(), version.id, client(), old)
                .unwrap_err();

        assert_eq!(refused.kind, "stale");
        assert_eq!(read(&app, &filename).body, "second");
    }
}
