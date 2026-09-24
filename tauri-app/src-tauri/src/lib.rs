// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
// `#[tauri::command]` arguments arrive by value: serde deserializes them out of
// the IPC payload, and `AppHandle` / `State` are injected owned. Borrowing them
// is not an option this crate has.
#![allow(clippy::needless_pass_by_value)]

#[cfg(target_os = "android")]
mod android_context;
#[cfg(target_os = "android")]
mod android_tls;
mod auth;
mod device;
mod export;
#[cfg(target_os = "macos")]
mod location;
mod place;
mod sync;
// Public because it is a real external surface: the JNI symbol inside is what
// the Android widget links against, and `unreachable_pub` is right that a
// private module cannot hold one honestly.
#[cfg(target_os = "android")]
pub mod widget_bridge;
// Only the Android JNI bridge reads this, but it is built everywhere so its
// tests run: CI has no Android target, and the parsing is the part worth
// testing.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod widget_summary;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use device::ClientContext;
use magical_merchant_core::{
    CreatedNote, GlyphFormat, GlyphName, GlyphSummary, NoteFilename, NoteKind, NoteMeta,
    NoteSummary, Provenance, Revision, SearchHit, Source, TemplateDetail, TemplateSummary,
    VarLocale, Version, VersionStatus,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt as _;

/// Moves reads that sweep every file off the main thread.
///
/// Synchronous commands run on the main thread. Listing, searching and backlinks
/// grow with the number of notes and of days (10 to 30ms for a year's worth,
/// several times that on a real device), and window input and events stop for that
/// long. Run them on the blocking pool, as `resolve_places` does, and return only
/// the result to the main thread.
async fn off_main_thread<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// Where this app's data lives.
///
/// Notes, the sync settings and the token are all under here and nowhere else.
///
/// Debug builds alone can point it elsewhere with `MAGICAL_MERCHANT_DATA_DIR`. It
/// matches the variable the CLI has had for a while (`cli/src/main.rs`), and it is
/// the way in for trying a new feature without touching real records:
/// `just sandbox` uses it. A shipped app has no need to move its data directory
/// from an environment variable, so the whole branch is gone in release.
pub(crate) fn app_base_dir(handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("MAGICAL_MERCHANT_DATA_DIR") {
        return Ok(std::path::PathBuf::from(dir));
    }
    handle.path().app_data_dir().map_err(|e| e.to_string())
}

fn parse_filename(filename: &str) -> Result<NoteFilename, String> {
    NoteFilename::parse(filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_quick_capture(
    handle: AppHandle,
    text: String,
    client: ClientContext,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let context = device::get_context(client);
    magical_merchant_core::save_scrawl_entry(&base_dir, &text, &context, Source::App)
        .map_err(|e| e.to_string())
}

/// `kind` names the directory: `codex` creates a document that keeps committed
/// versions. Left out, it is an ordinary note.
#[tauri::command]
fn create_draft(
    handle: AppHandle,
    body: String,
    tags: Vec<String>,
    client: ClientContext,
    origin: Option<String>,
    kind: Option<NoteKind>,
) -> Result<String, String> {
    let base_dir = app_base_dir(&handle)?;
    let context = device::get_context(client);
    // With an origin it is a promotion from a Scrawl entry. Record where it came
    // from in the frontmatter
    let provenance = Provenance {
        origin: origin.as_deref(),
        source: Some(Source::App),
        ..Provenance::default()
    };
    let create = match kind.unwrap_or(NoteKind::Note) {
        NoteKind::Note => magical_merchant_core::create_draft_note,
        NoteKind::Codex => magical_merchant_core::create_draft_codex,
    };
    let path = create(&base_dir, &body, &tags, &context, provenance).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Turns a Note into a Codex. The ID does not change. There is no way back.
#[tauri::command]
fn promote_note_to_codex(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::promote_note_to_codex(&base_dir, &filename).map_err(|e| e.to_string())
}

/// A failed save. It carries a mark the frontend branches on.
///
/// - `stale`: someone wrote after this read. Read again and tell the user
/// - `broken`: the record at the head of the note cannot be read and core refused
///   the write. Set the typed text aside and tell the user: no amount of rewriting
///   will get through
/// - `missing`: the note is gone (deleted, or moved to Codex). Core does not
///   recreate it, so set the typed text aside here as well and tell the user
/// - `notText`: the file content does not read as text (invalid UTF-8). It is kept
///   apart from `broken` because it means something else and calls for something
///   else: rewriting the record does not fix it, and reopening cannot read the body
///   either, so there is no way out through "restore"
#[derive(Debug, Clone, serde::Serialize)]
struct SaveError {
    kind: &'static str,
    message: String,
}

impl SaveError {
    /// Failures that never reached core (the data directory cannot be resolved, the
    /// filename is not a note name). There is no mark that tells them apart, so they
    /// fall to `other`.
    const fn other(message: String) -> Self {
        Self {
            kind: "other",
            message,
        }
    }
}

impl From<magical_merchant_core::CoreError> for SaveError {
    fn from(e: magical_merchant_core::CoreError) -> Self {
        Self {
            kind: match e {
                magical_merchant_core::CoreError::Stale(_) => "stale",
                magical_merchant_core::CoreError::Parse(_) => "broken",
                magical_merchant_core::CoreError::NotFound(_) => "missing",
                magical_merchant_core::CoreError::NotText(_) => "notText",
                _ => "other",
            },
            message: e.to_string(),
        }
    }
}

/// `revision` is the fingerprint of the body `read_note` returned.
///
/// Supply it and the write is refused as `stale` if the CLI or MCP rewrote the same
/// note in between. What comes back is the revision of the body just written:
/// supply that on the next save.
///
/// It takes the ID (the filename) only and asks core for the directory. Writing an
/// absolute path handed over from the `WebView` as it is would also allow writes
/// outside `data/`, and onto the traces of deleted notes and of notes turned into a
/// Codex.
// AIDEV-NOTE: same parse_filename to locate route as the other note commands. Do not go back to taking a path
#[tauri::command]
fn update_draft(
    handle: AppHandle,
    filename: String,
    body: String,
    client: ClientContext,
    revision: Option<String>,
) -> Result<String, SaveError> {
    let base_dir = app_base_dir(&handle).map_err(SaveError::other)?;
    let filename = parse_filename(&filename).map_err(SaveError::other)?;
    // Core's refusal turns into a mark in one place. Flattening it to a string here
    // would deliver the reason the note was not found under a different mark from
    // the same reason raised by `update_note`
    let (_, path) =
        magical_merchant_core::locate_note(&base_dir, &filename).map_err(SaveError::from)?;
    let context = device::get_context(client);
    let expected = revision.map(Revision::from);
    magical_merchant_core::update_note(&path, &body, &context, expected.as_ref())
        .map(|r| r.to_string())
        .map_err(SaveError::from)
}

#[derive(Debug, Clone, serde::Serialize)]
struct NoteRead {
    body: String,
    /// Fingerprint of the body. Supply it to `update_draft` so a write from
    /// outside is not written over.
    revision: String,
}

/// Clean-up that runs once per launch, before the first listing.
///
/// It is not done in `setup` because Android's `app_data_dir` cannot be called from
/// the main thread, and to keep a listing from before the repair off the screen even
/// for a moment. Either one failing is passed over silently: that beats leaving
/// notes unreadable, and the next launch tries again.
///
/// This is not repair for the sake of sync. The engine does that inside
/// `.sync.lock` (`core/src/sync/engine.rs`). What stays here is so that the listing
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
async fn list_notes(handle: AppHandle) -> Result<Vec<NoteSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        repair_once(&base_dir);

        magical_merchant_core::list_notes(&base_dir).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
fn read_note(handle: AppHandle, filename: String) -> Result<NoteRead, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    let body = magical_merchant_core::read_note_by_filename(&base_dir, &filename)
        .map_err(|e| e.to_string())?;
    let revision = Revision::of(&body).to_string();
    Ok(NoteRead { body, revision })
}

#[tauri::command]
async fn find_backlinks(handle: AppHandle, filename: String) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    off_main_thread(move || {
        magical_merchant_core::find_backlinks(&base_dir, &filename).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
fn read_note_meta(handle: AppHandle, filename: String) -> Result<NoteMeta, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_note_meta(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_note_meta(
    handle: AppHandle,
    filename: String,
    time: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    // Take RFC 3339 with an offset. With a bare date and time, the same input would
    // point at a different instant as soon as the device time zone changed
    let time = chrono::DateTime::parse_from_rfc3339(&time).map_err(|e| e.to_string())?;
    magical_merchant_core::update_note_meta(&base_dir, &filename, time, &tags)
        .map_err(|e| e.to_string())
}

/// Rewrites the view mode only. `None` goes back to the default (the editor).
#[tauri::command]
fn set_note_view(handle: AppHandle, filename: String, view: Option<String>) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::update_note_view(&base_dir, &filename, view.as_deref())
        .map_err(|e| e.to_string())
}

/// Rewrites only the link to the entry it was promoted from. `None` unties it.
#[tauri::command]
fn set_note_origin(
    handle: AppHandle,
    filename: String,
    origin: Option<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::update_note_origin(&base_dir, &filename, origin.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_templates(handle: AppHandle) -> Result<Vec<TemplateSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_templates(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_template(handle: AppHandle, filename: String) -> Result<TemplateDetail, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_template(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_template(
    handle: AppHandle,
    filename: String,
    body: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::save_template(&base_dir, &filename, &body, &tags)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_template(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::delete_template(&base_dir, &filename).map_err(|e| e.to_string())
}

/// Keeps the edit in progress beside the template. Returns whether a draft is left: one
/// equal to the saved template is removed instead.
#[tauri::command]
fn save_template_draft(
    handle: AppHandle,
    filename: String,
    body: String,
    tags: Vec<String>,
) -> Result<bool, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::save_template_draft(&base_dir, &filename, &TemplateDetail { body, tags })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_template_draft(
    handle: AppHandle,
    filename: String,
) -> Result<Option<TemplateDetail>, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_template_draft(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn discard_template_draft(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::discard_template_draft(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_template_drafts(handle: AppHandle) -> Result<Vec<TemplateSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_template_drafts(&base_dir).map_err(|e| e.to_string())
}

/// Creates a note from a template.
///
/// If today's note from the same template already exists, it is returned instead of
/// creating one (`reused`).
///
/// It takes `locale` for `{{weekday}}`. Only the names of the days should follow
/// the device language, and the screen is the only side that knows that language.
#[tauri::command]
fn create_from_template(
    handle: AppHandle,
    filename: String,
    client: ClientContext,
    locale: String,
) -> Result<CreatedNote, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    let context = device::get_context(client);
    magical_merchant_core::create_note_from_template(
        &base_dir,
        &filename,
        &context,
        VarLocale::parse(&locale),
        Provenance {
            source: Some(Source::App),
            ..Provenance::default()
        },
    )
    .map_err(|e| e.to_string())
}

fn parse_glyph_name(name: &str) -> Result<GlyphName, String> {
    GlyphName::parse(name).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_glyphs(handle: AppHandle) -> Result<Vec<GlyphSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_glyphs(&base_dir).map_err(|e| e.to_string())
}

/// One entry, looked up when the screen draws `:name:`.
#[derive(serde::Serialize)]
struct GlyphAsset {
    name: String,
    /// `data:image/...;base64,...`.
    url: String,
}

/// Returns every registered glyph as a data URL.
///
/// They come back in one call so the screen can look a name up synchronously while
/// it draws the body. They are not served over the asset protocol or a custom
/// scheme because that way no new capability has to be opened, and the browser
/// harness can imitate it as it is.
#[tauri::command]
fn read_glyphs(handle: AppHandle) -> Result<Vec<GlyphAsset>, String> {
    let base_dir = app_base_dir(&handle)?;
    let mut assets = Vec::new();
    for summary in magical_merchant_core::list_glyphs(&base_dir).map_err(|e| e.to_string())? {
        // Do not fail all of them over one glyph deleted right after it was listed
        let Ok(name) = GlyphName::parse(&summary.name) else {
            continue;
        };
        let Ok(glyph) = magical_merchant_core::read_glyph(&base_dir, &name) else {
            continue;
        };
        assets.push(GlyphAsset {
            name: summary.name,
            url: format!(
                "data:{};base64,{}",
                glyph.format.mime(),
                B64.encode(&glyph.bytes)
            ),
        });
    }
    Ok(assets)
}

#[tauri::command]
fn save_glyph(
    handle: AppHandle,
    name: String,
    format: String,
    data_base64: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let name = parse_glyph_name(&name)?;
    let format = GlyphFormat::parse(&format).map_err(|e| e.to_string())?;
    let bytes = B64.decode(data_base64).map_err(|e| e.to_string())?;
    magical_merchant_core::save_glyph(&base_dir, &name, format, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_glyph(handle: AppHandle, name: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let name = parse_glyph_name(&name)?;
    magical_merchant_core::delete_glyph(&base_dir, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_scrawl_dates(handle: AppHandle) -> Result<Vec<String>, String> {
    let base_dir = app_base_dir(&handle)?;
    let dates = magical_merchant_core::list_scrawl_dates(&base_dir).map_err(|e| e.to_string())?;
    Ok(dates
        .iter()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .collect())
}

#[tauri::command]
fn read_scrawl_by_date(handle: AppHandle, date: String) -> Result<Vec<String>, String> {
    let base_dir = app_base_dir(&handle)?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::read_scrawl(&base_dir, naive).map_err(|e| e.to_string())
}

/// `raw` is the line as the screen read it. With the index it names which record.
#[tauri::command]
fn delete_scrawl_entry(
    handle: AppHandle,
    date: String,
    index: usize,
    raw: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::delete_scrawl_entry(&base_dir, naive, index, &raw)
        .map_err(|e| e.to_string())
}

/// Turns coordinates into place names.
///
/// Only the ones that resolved come back, keyed by `"latitude,longitude"`.
///
/// The record keeps the coordinates. What comes back is a rewording for reading, so
/// when a coordinate that did not resolve is missing, the caller can just print the
/// coordinates.
///
/// It is `async` because it must not run on the main thread. Synchronous commands
/// run on the main thread, and the geocoder's answer is queued on the main queue as
/// well. Waiting there blocks its own reply and always times out.
#[tauri::command]
async fn resolve_places(
    handle: AppHandle,
    coordinates: Vec<(f64, f64)>,
    locale: String,
) -> Result<Vec<(String, String)>, String> {
    let base_dir = app_base_dir(&handle)?;
    tauri::async_runtime::spawn_blocking(move || place::resolve(&base_dir, &coordinates, &locale))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_all(
    handle: AppHandle,
    query: String,
    tags: Vec<String>,
) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || {
        magical_merchant_core::search_all(&base_dir, &query, &tags).map_err(|e| e.to_string())
    })
    .await
}

/// Every record.
///
/// It does not filter by text, so it takes no arguments and the count is not
/// capped: the screen counts kind / tag / period from here. The scan costs the same
/// as `search_all`, so it is called only when the screen opens.
#[tauri::command]
async fn browse_all(handle: AppHandle) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    off_main_thread(move || magical_merchant_core::browse_all(&base_dir).map_err(|e| e.to_string()))
        .await
}

/// Commits the current draft as a version. Called only when a person asks to
/// commit a version.
#[tauri::command]
fn commit_note_version(
    handle: AppHandle,
    filename: String,
    message: Option<String>,
) -> Result<Version, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::commit_note_version(&base_dir, &filename, message.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_note_versions(handle: AppHandle, filename: String) -> Result<Vec<Version>, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::list_note_versions(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note_version(handle: AppHandle, filename: String, id: String) -> Result<String, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_note_version(&base_dir, &filename, &id).map_err(|e| e.to_string())
}

/// Unified diff from version `from` to the current draft. Two versions are never
/// compared: the screen only shows what changed since this version.
#[tauri::command]
fn diff_note_versions(handle: AppHandle, filename: String, from: String) -> Result<String, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::diff_note_versions(&base_dir, &filename, &from, None)
        .map_err(|e| e.to_string())
}

/// Makes a version's body the draft. `revision` means what it means in
/// `update_draft`; a mismatch is `stale`. Core commits the draft as a version
/// before writing over it.
#[tauri::command]
fn restore_note_version(
    handle: AppHandle,
    filename: String,
    id: String,
    client: ClientContext,
    revision: Option<String>,
) -> Result<String, SaveError> {
    let base_dir = app_base_dir(&handle).map_err(SaveError::other)?;
    let filename = parse_filename(&filename).map_err(SaveError::other)?;
    let context = device::get_context(client);
    let expected = revision.map(Revision::from);
    magical_merchant_core::restore_note_version(
        &base_dir,
        &filename,
        &id,
        &context,
        expected.as_ref(),
    )
    .map(|r| r.to_string())
    .map_err(SaveError::from)
}

/// The "undo" right after a commit. It only deletes the version file and does not
/// touch the body.
#[tauri::command]
fn delete_note_version(handle: AppHandle, filename: String, id: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::delete_note_version(&base_dir, &filename, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn note_version_status(handle: AppHandle, filename: String) -> Result<VersionStatus, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::note_version_status(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::delete_note(&base_dir, &filename).map_err(|e| e.to_string())
}

/// Takes from a deep link only the JWT that may be stored.
///
/// The widget's own `magical-merchant://widget/` links arrive on the same scheme,
/// so a `?token=` alone is not enough. Only links whose host is `auth` count, and
/// the value has to be a live JWT as well: storing an expired one overwrites a
/// valid token and leaves the next sync stopped at "please log in again"
fn token_from_urls(urls: &[url::Url]) -> Option<String> {
    urls.iter()
        .filter(|url| url.host_str() == Some("auth"))
        .flat_map(url::Url::query_pairs)
        .filter(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .find(|token| magical_merchant_core::sync::token::is_token_valid(token))
}

/// Stores the JWT that came back from the OAuth callback.
///
/// Without telling the frontend the result, a completed login never reaches the UI
/// and a failure is swallowed.
///
/// On Android `app_data_dir` is a synchronous call into a plugin, and the main
/// thread is what carries its reply. Deep link events are delivered on that same
/// main thread, so calling it directly here waits on its own reply and freezes the
/// whole Activity. Always move it to another thread.
fn store_token_from_urls(handle: &AppHandle, urls: &[url::Url]) {
    let Some(token) = token_from_urls(urls) else {
        return;
    };

    let handle = handle.clone();
    std::thread::spawn(move || {
        let stored = app_base_dir(&handle)
            .and_then(|dir| magical_merchant_core::sync::token::store_token(&dir, &token));

        match stored {
            Ok(()) => {
                let _ = handle.emit("auth-success", ());
            }
            Err(e) => {
                let _ = handle.emit("auth-error", e);
            }
        }
    });
}

// `mobile_entry_point` fixes the signature to `fn run()`, so a failed startup
// has nowhere to be returned to — panicking is the only way to report it.
// `generate_context!` embeds every plugin's permission tables in one value;
// with dialog and fs on board it crosses clippy's stack-frame threshold. It
// is built once at startup, so the frame size is not a concern.
#[allow(clippy::expect_used, clippy::large_stack_frames)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_opener::init())
        // Diagram export: the save dialog, and writing to content:// on Android
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sync::AppSyncState::default())
        .setup(|app| {
            // Android has nothing listening for `log`, and warnings from dependency
            // crates are thrown away. The rustls-platform-verifier that android_tls
            // below uses writes the reason it rejected a certificate here and
            // nowhere else, so initialise this before that. Release stops at Warn
            // because going down to Debug fills logcat with dependency crates'
            // routine logs and the one line that matters scrolls away.
            #[cfg(target_os = "android")]
            android_logger::init_once(
                android_logger::Config::default()
                    .with_max_level(if cfg!(debug_assertions) {
                        log::LevelFilter::Debug
                    } else {
                        log::LevelFilter::Warn
                    })
                    .with_tag("magical-merchant"),
            );

            // If the OS reclaims the app while the browser is authenticating, the
            // token arrives as the launch URL. The `new-url` event only fires when
            // the app stayed alive, so a login fails silently unless both are read.
            //
            // get_current is a synchronous plugin call too, so do not wait on it
            // inside setup.
            let launch_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(Some(urls)) = launch_handle.deep_link().get_current() {
                    store_token_from_urls(&launch_handle, &urls);
                }
            });

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                store_token_from_urls(&handle, &urls);
            });

            // There is a gap between starting to locate and the first fix coming
            // back. Asking on every save is too late, so start receiving at launch.
            #[cfg(target_os = "macos")]
            location::start(app.handle());

            // The geocoder and the certificate verifier need a Context. The Activity
            // can be destroyed, so hold an Application Context of our own while one
            // is alive.
            #[cfg(target_os = "android")]
            if let Err(e) = android_context::init() {
                log::error!("android context init failed: {e}");
            }

            // Android's trust store is reachable only from Java, so the platform
            // verifier has to be initialised before any HTTPS request. Sync itself
            // goes around it today (`android_tls::sync_tls_config`); the wiring
            // stays so it works again once upstream #221 is fixed.
            #[cfg(target_os = "android")]
            android_tls::init();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_quick_capture,
            create_draft,
            promote_note_to_codex,
            commit_note_version,
            list_note_versions,
            read_note_version,
            diff_note_versions,
            restore_note_version,
            delete_note_version,
            note_version_status,
            update_draft,
            list_notes,
            read_note,
            read_note_meta,
            find_backlinks,
            update_note_meta,
            set_note_origin,
            set_note_view,
            list_templates,
            read_template,
            save_template,
            delete_template,
            save_template_draft,
            read_template_draft,
            discard_template_draft,
            list_template_drafts,
            create_from_template,
            list_glyphs,
            read_glyphs,
            save_glyph,
            delete_glyph,
            list_scrawl_dates,
            read_scrawl_by_date,
            delete_scrawl_entry,
            search_all,
            browse_all,
            resolve_places,
            delete_note,
            export::save_export,
            sync::sync_start,
            sync::sync_status,
            auth::auth_login,
            auth::auth_status,
            auth::auth_logout,
            auth::get_sync_config,
            auth::save_sync_config,
            auth::is_sync_config_editable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// A save to a note that is not text is a refusal reading again will not fix.
    ///
    /// Dropping it into `other` makes the screen treat it as a temporary failure and
    /// discard it silently, and the typed text is closed away with no warning, left
    /// neither on disk nor in a backup.
    #[test]
    fn a_note_that_is_not_text_is_refused_under_its_own_mark() {
        let not_text = SaveError::from(magical_merchant_core::CoreError::NotText(
            "a.md".to_string(),
        ));
        // A temporary failure stays without a mark. The next keystroke may still get
        // through, so it is not one to set aside and call unwritable
        let io = SaveError::from(magical_merchant_core::CoreError::Io(std::io::Error::other(
            "disk full",
        )));

        assert_eq!(not_text.kind, "notText");
        assert_eq!(io.kind, "other");
    }

    /// Nobody checks the signature (same reason as `sync::token::is_token_valid`),
    /// so the three parts are assembled directly
    fn jwt(expires_in: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let exp = chrono::Utc::now().timestamp() + expires_in;
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    fn urls(raw: &[String]) -> Vec<url::Url> {
        raw.iter().map(|u| url::Url::parse(u).unwrap()).collect()
    }

    #[test]
    fn the_auth_callback_token_is_taken() {
        let token = jwt(3600);
        let links = urls(&[format!("magical-merchant://auth/callback?token={token}")]);

        assert_eq!(token_from_urls(&links), Some(token));
    }

    /// A widget deep link arrives on the same scheme. Adding a `?token=` must not
    /// be enough to swap the account things are saved to
    #[test]
    fn a_token_on_a_widget_link_is_ignored() {
        let links = urls(&[format!(
            "magical-merchant://widget/new-note?token={}",
            jwt(3600)
        )]);

        assert_eq!(token_from_urls(&links), None);
    }

    /// Storing an expired token leaves nothing but a state where the next sync
    /// stops at "please log in again", with the valid token overwritten as well
    #[test]
    fn an_expired_or_malformed_token_is_ignored() {
        let expired = urls(&[format!(
            "magical-merchant://auth/callback?token={}",
            jwt(-100)
        )]);
        let garbage = urls(&["magical-merchant://auth/callback?token=not-a-jwt".to_string()]);

        assert_eq!(token_from_urls(&expired), None);
        assert_eq!(token_from_urls(&garbage), None);
    }
}
