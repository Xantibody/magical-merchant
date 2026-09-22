//! The body of sync. However many callers there are, there is only one implementation.
//! Two things call it: the app and the CLI's `sync`.
//!
//! The invariants written here (never send our own state back, never rebuild the state
//! from a rescan after downloading, refuse a wholesale delete) are guarded only by
//! comments. A second copy would drift without fail, so do not fork it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::{DateTime, Utc};

use super::client::{
    BulkRequest, BulkResponse, DownloadedFile, HttpClient, ServerSyncState, SyncTransport,
    WireConflictOp, WireUpload,
};
use super::conflict;
use super::diff::{self, RemoteFile, SyncAction};
use super::lock::SyncLock;
use super::round::{self, BULK_OPERATION_BUDGET};
use super::scan::{self, LocalFile};
use super::state::{FileSyncRecord, SyncState};
use super::{SyncError, SyncIssue, SyncResult};
use crate::utils::paths;

const MAX_SYNC_ATTEMPTS: usize = 3;

/// The cap on rounds in one sync. No action costs more than the budget
/// (even a conflict's 3 fits in the budget of 40), so hitting this means a bug.
/// A round that makes no progress becomes `stalled` at once; this ceiling is a backstop.
const MAX_ROUNDS: usize = 200;

/// Called each time a round finishes. Only the CLI shows progress; the app keeps its
/// spinner turning.
#[derive(Debug, Clone, Copy)]
pub struct RoundProgress {
    /// The round number, counted from 1. How many rounds there will be in total is
    /// unknown until it is done: another device writing midway adds more
    pub round: usize,
    /// The number of actions sent in this round
    pub done: usize,
    /// The number of actions that did not fit the budget and moved to the next round
    pub remaining: usize,
}

/// One sync. The caller passes an authenticated `HttpClient`.
pub async fn run(client: &HttpClient, base_dir: &Path) -> Result<SyncResult, SyncError> {
    run_over(client, base_dir, BULK_OPERATION_BUDGET, |_| {}).await
}

/// The variant that reports per round. Keeps a send of hundreds of files from looking stuck.
pub async fn run_with_progress<F: FnMut(RoundProgress)>(
    client: &HttpClient,
    base_dir: &Path,
    on_round: F,
) -> Result<SyncResult, SyncError> {
    run_over(client, base_dir, BULK_OPERATION_BUDGET, on_round).await
}

/// The body. Taking a `SyncTransport` instead of an `HttpClient`, and the budget as an
/// argument, are both for the tests. The public entry points stay the two above.
async fn run_over<T: SyncTransport + Sync, F: FnMut(RoundProgress)>(
    client: &T,
    base_dir: &Path,
    budget: usize,
    mut on_round: F,
) -> Result<SyncResult, SyncError> {
    // Running at the same time as another process on the same data directory, the
    // `.sync-state.json` written last survives and the other's records vanish.
    // It is held through the retries too, so it is taken once, here.
    // Bind it to a name: `let _ = ` would release it immediately
    let _lock = SyncLock::acquire(base_dir)?;

    sweep_stale_temp_files(base_dir);
    repair_tree(base_dir);

    let result = run_rounds(client, base_dir, budget, &mut on_round).await;

    if result.is_ok() {
        // The same ID sits in both `notes/` and `codex/` right after a download, so look
        // again at what the run brought in. The lock is still held
        let _ = crate::relocate_duplicate_ids(base_dir);
    }
    result
}

/// Mending of the tree that happens before the scan. Each side that starts a sync used
/// to call this itself; it moved here because a repair moves files, and outside the lock
/// it would rewrite the tree while the other process is scanning it. A moved note looks
/// to the other side like a local disappearance, and the remote copy gets deleted too
/// (#250).
///
/// Sync works even when a repair fails, so failures are swallowed and not even logged.
/// Stopping the sync because a repair did not succeed would cost more.
///
/// AIDEV-NOTE: Taking the lock on the caller's side is not an option. flock is per fd, so
/// the engine's acquire returns busy
fn repair_tree(base_dir: &Path) {
    // `data/timeline/` from before the rename. Unless it moves before the scan, the sync
    // builds on the old keys
    let _ = crate::migrate_scrawl_dir(base_dir);
    // Garbled metadata that past edits mixed into the head of the body
    let _ = crate::repair_notes(base_dir);
    // Conflict copies an old version put in `data/`. Unless they move out before the
    // scan, the leftovers get handed to every device as new notes
    let _ = crate::relocate_conflict_copies(base_dir);
    // When another device's promotion and our offline edit overlap, the same ID is in
    // both `notes/` and `codex/`. The Codex side is the real one; the `notes/` side becomes a copy
    let _ = crate::relocate_duplicate_ids(base_dir);
}

/// Until the rounds run out. Split out of `run_over` so what happens while the lock is
/// held can be read in the few lines of the entry point.
async fn run_rounds<T: SyncTransport + Sync, F: FnMut(RoundProgress)>(
    client: &T,
    base_dir: &Path,
    budget: usize,
    on_round: &mut F,
) -> Result<SyncResult, SyncError> {
    let mut total = SyncResult::default();
    for round in 1..=MAX_ROUNDS {
        let outcome = sync_round(client, base_dir, budget).await?;
        absorb(&mut total, outcome.result);
        on_round(RoundProgress {
            round,
            done: outcome.done,
            remaining: outcome.remaining,
        });
        if outcome.remaining == 0 {
            return Ok(total);
        }
        if outcome.done == 0 {
            return Err(stalled(&format!(
                "Sync stopped making progress with {} change(s) left.",
                outcome.remaining
            )));
        }
    }
    // Stopping midway breaks nothing: the state is written per round, so what was
    // sent is not redone on the next sync
    Err(stalled(&format!(
        "Sync gave up after {MAX_ROUNDS} rounds. What it managed to send is kept; \
         run it again to continue."
    )))
}

/// For when it is clear that looping on will never finish. No action exceeds the budget
/// (even a conflict's 3 fits in 40), so getting here means a bug, or the same key
/// jamming over and over. Better to stop and show it than to spin in silence.
fn stalled(what_happened: &str) -> SyncError {
    SyncError::new(
        "stalled",
        format!("{what_happened} Try again; if it keeps happening, report it."),
    )
}

fn absorb(total: &mut SyncResult, round: SyncResult) {
    total.uploaded += round.uploaded;
    total.downloaded += round.downloaded;
    total.deleted_remote += round.deleted_remote;
    total.deleted_local += round.deleted_local;
    total.conflicts += round.conflicts;
    total.errors.extend(round.errors);
}

/// The result of one round and the number still left.
struct RoundOutcome {
    result: SyncResult,
    done: usize,
    remaining: usize,
}

async fn sync_round<T: SyncTransport + Sync>(
    client: &T,
    base_dir: &Path,
    budget: usize,
) -> Result<RoundOutcome, SyncError> {
    // Syncing at the same time as another device gets rejected by the CAS. There is no
    // reason to make the user retry, so fetch again and redo it automatically
    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let outcome = sync_once(client, base_dir, budget).await;
        let retryable =
            matches!(&outcome, Err(err) if err.kind == "conflict") && attempt < MAX_SYNC_ATTEMPTS;
        if !retryable {
            return outcome;
        }
    }
    unreachable!("the loop returns on its last attempt")
}

async fn sync_once<T: SyncTransport + Sync>(
    client: &T,
    base_dir: &Path,
    budget: usize,
) -> Result<RoundOutcome, SyncError> {
    let server_state = client.get_sync_state().await?;

    let local_files =
        scan::scan_local_files(base_dir).map_err(|e| SyncError::other(e.to_string()))?;
    let local_state = SyncState::load(base_dir).map_err(|e| SyncError::other(e.to_string()))?;

    let remote_files = server_state_to_remote_files(&server_state);
    let actions = diff::compute(&local_files, &remote_files, &local_state);

    // The wholesale-delete check runs every round, over everything, before the split.
    // After the split it would look like a "partial delete" of 40 at a time and the brake
    // would not work
    refuse_wholesale_local_deletion(&actions, &local_files)?;

    let (actions, deferred) = round::take_round(&actions, budget);

    let data_dir = paths::data_dir(base_dir);
    let mut result = SyncResult::default();
    let bulk_req = build_bulk_request(
        &actions,
        &local_files,
        &data_dir,
        server_state.etag.clone(),
        &mut result,
    )
    // The side where the sync itself stops. The CLI and the app's generic error display
    // both take English
    .map_err(|issue| SyncError::other(issue.to_string()))?;

    let bulk_resp = client.bulk(bulk_req).await?;

    let unwritten = apply_response(&bulk_resp, &actions, &local_files, base_dir, &mut result);

    // Progress is the number settled, not the number sent. A key whose write failed is
    // picked in the same order in the next round too, so counting by sent would repeat
    // the same 40 for 200 rounds while claiming "progress"
    let settled = actions
        .iter()
        .filter(|a| !unwritten.contains(a.key()))
        .count();

    let mut unsettled = unwritten;
    // Keys moved to the next round get the same treatment as keys whose fetch failed.
    // Recorded at the version the server settled on, the old version on disk would look
    // like "a local edit" in the next round, and the download that was meant to fetch
    // it would turn into an upload and crush the new version
    unsettled.extend(deferred.iter().map(|a| a.key().to_string()));

    // Record the state the server settled on locally, as is.
    // Rescanning local files to rebuild it here would make the mtime right after a
    // download disagree with the server's version, and the same file would be fetched forever

    save_local_state(
        base_dir,
        &bulk_resp.new_state,
        &data_dir,
        &unsettled,
        &local_state,
    )
    .map_err(SyncError::other)?;

    Ok(RoundOutcome {
        result,
        done: settled,
        remaining: deferred.len(),
    })
}

/// A `.sync-tmp-*` older than this counts as left behind by a writer that crashed.
/// A live write holds one only for the instant between `fs::write` and `rename`
const STALE_TMP_AGE: std::time::Duration = std::time::Duration::from_hours(1);

/// The temp file of `write_atomic` remains when the process dies before the rename.
/// Nobody else cleans up the ones directly under `<base>`, so they are picked up here.
///
/// Filtering by age is so a temp file another write is about to rename does not get
/// deleted, which would make that save fail. A failed cleanup has no bearing on the
/// sync, so it goes on in silence.
fn sweep_stale_temp_files(base_dir: &Path) {
    let Ok(entries) = fs::read_dir(base_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(".sync-tmp-")
        {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|modified| {
                modified
                    .elapsed()
                    .is_ok_and(|elapsed| elapsed >= STALE_TMP_AGE)
            });
        if old_enough {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Below this, assume the user really deleted them and let it through.
/// A wholesale delete of 1 or 2 files can be recovered from even if it is an accident
const WHOLESALE_DELETION_THRESHOLD: usize = 3;

/// When the server's sync state is corrupt and empty, the diff sees a wholesale local delete.
/// Every local note vanishing in one sync is almost never the intended result, so stop it.
fn refuse_wholesale_local_deletion(
    actions: &[SyncAction],
    local_files: &[LocalFile],
) -> Result<(), SyncError> {
    if local_files.len() < WHOLESALE_DELETION_THRESHOLD {
        return Ok(());
    }
    let deletions = actions
        .iter()
        .filter(|a| matches!(a, SyncAction::DeleteLocal { .. }))
        .count();
    if deletions < local_files.len() {
        return Ok(());
    }
    Err(SyncError::new(
        "unsafeDeletion",
        format!(
            "Sync stopped: the server reports every one of your {deletions} local files as deleted. \
             If that is really what you want, delete .sync-state.json in the app data directory and sync again."
        ),
    ))
}

fn server_state_to_remote_files(state: &ServerSyncState) -> Vec<RemoteFile> {
    state
        .files
        .iter()
        .filter_map(|(key, rec)| {
            let last_modified: DateTime<Utc> = rec.last_modified.parse().ok()?;
            Some(RemoteFile {
                key: key.clone(),
                last_modified,
                content_hash: rec.hash.clone(),
            })
        })
        .collect()
}

/// Whether the key cannot point outside the data directory.
///
/// The danger is the **path component** `..`, not dots next to each other in a name.
/// Rejecting on a substring match would also catch `<stem>.sync-conflict-20260511-031336..md`
/// (a name with one dot too many, found in copies from before server-driven sync), and a
/// device holding such a copy would fail every sync. Reading it through `Path` makes the
/// separator handling match the OS.
fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && !key.contains('\0')
        && Path::new(key)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

fn build_bulk_request(
    actions: &[SyncAction],
    local_files: &[LocalFile],
    data_dir: &Path,
    expected_etag: Option<String>,
    result: &mut SyncResult,
) -> Result<BulkRequest, SyncIssue> {
    let local_map: HashMap<&str, &LocalFile> =
        local_files.iter().map(|f| (f.key.as_str(), f)).collect();

    let mut uploads: Vec<WireUpload> = Vec::new();
    let mut downloads: Vec<String> = Vec::new();
    let mut delete_remote: Vec<String> = Vec::new();
    let mut conflicts: Vec<WireConflictOp> = Vec::new();

    for action in actions {
        let key = action.key();
        if !is_safe_key(key) {
            result.errors.push(SyncIssue::UnsafeKey {
                key: key.to_string(),
            });
            continue;
        }

        match action {
            SyncAction::UploadNew { key } | SyncAction::UploadModified { key } => {
                let local = local_map
                    .get(key.as_str())
                    .ok_or_else(|| SyncIssue::MissingLocalFile { key: key.clone() })?;
                let content = fs::read(data_dir.join(key)).map_err(|e| SyncIssue::ReadFailed {
                    key: key.clone(),
                    detail: e.to_string(),
                })?;
                uploads.push(WireUpload {
                    key: key.clone(),
                    content_base64: B64.encode(&content),
                    last_modified: local.last_modified.to_rfc3339(),
                    hash: local.content_hash.clone(),
                });
            }
            SyncAction::DownloadNew { key } | SyncAction::DownloadModified { key } => {
                downloads.push(key.clone());
            }
            SyncAction::DeleteRemote { key } => {
                delete_remote.push(key.clone());
            }
            SyncAction::DeleteLocal { key: _ } => {
                // A local delete is handled entirely on the client side (not in the bulk request)
            }
            SyncAction::Conflict { key } => {
                // When both sides changed, local wins. The discarded side remains as a
                // conflict copy, so neither edit is lost
                let local = local_map
                    .get(key.as_str())
                    .ok_or_else(|| SyncIssue::MissingLocalFile { key: key.clone() })?;
                let content = fs::read(data_dir.join(key)).map_err(|e| SyncIssue::ReadFailed {
                    key: key.clone(),
                    detail: e.to_string(),
                })?;
                conflicts.push(WireConflictOp {
                    key: key.clone(),
                    conflict_key: conflict::conflict_filename(key, Utc::now()),
                    content_base64: B64.encode(&content),
                    hash: local.content_hash.clone(),
                    last_modified: local.last_modified.to_rfc3339(),
                });
            }
        }
    }

    Ok(BulkRequest {
        uploads,
        downloads,
        delete_remote,
        conflicts,
        expected_etag,
    })
}

fn write_under(data_dir: &Path, key: &str, content: &[u8]) -> Result<(), SyncIssue> {
    if !is_safe_key(key) {
        return Err(SyncIssue::UnsafeKey {
            key: key.to_string(),
        });
    }
    let path = data_dir.join(key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| SyncIssue::WriteFailed {
            key: key.to_string(),
            detail: format!("mkdir: {e}"),
        })?;
    }
    // Overwriting in place, a crash while writing a download would replace the local
    // note with a half-written file
    crate::utils::fs::write_atomic(&path, content).map_err(|e| SyncIssue::WriteFailed {
        key: key.to_string(),
        detail: e.to_string(),
    })
}

fn decode(file: &DownloadedFile) -> Result<Vec<u8>, SyncIssue> {
    B64.decode(&file.content_base64)
        .map_err(|e| SyncIssue::DecodeFailed {
            key: file.key.clone(),
            detail: e.to_string(),
        })
}

/// Applies the server's reply locally. Returns the keys that could not be written.
///
/// Leaving here on one failure would never reach `save_local_state`, and the broken key
/// would stop every sync at the same spot. Failures go onto `result.errors` and the
/// work goes on; a key that could not be written is not recorded as "synced".
fn apply_response(
    bulk_resp: &BulkResponse,
    actions: &[SyncAction],
    local_files: &[LocalFile],
    base_dir: &Path,
    result: &mut SyncResult,
) -> HashSet<String> {
    let data_dir = paths::data_dir(base_dir);
    let mut unwritten = HashSet::new();

    for d in &bulk_resp.downloads {
        match decode(d).and_then(|content| write_under(&data_dir, &d.key, &content)) {
            Ok(()) => result.downloaded += 1,
            Err(e) => {
                result.errors.push(e);
                unwritten.insert(d.key.clone());
            }
        }
    }

    // The remote side that lost the conflict. It goes outside `data/`, so it is neither
    // synced nor listed among the notes.
    // A failure does not go into `unwritten`: a copy's key is not in the state, so
    // adding it would exclude nothing (the server keeps its copy, so no content is lost)
    let conflicts_dir = paths::conflicts_dir(base_dir);
    for d in &bulk_resp.conflict_downloads {
        // If the name does not parse, file it under the key as is. An old shape is still a copy
        let key = conflict::conflict_copy_path(&d.key).unwrap_or_else(|| d.key.clone());
        if let Err(e) = decode(d).and_then(|content| write_under(&conflicts_dir, &key, &content)) {
            result.errors.push(e);
        }
    }

    for action in actions {
        match action {
            SyncAction::UploadNew { .. } | SyncAction::UploadModified { .. } => {
                result.uploaded += 1;
            }
            SyncAction::DeleteRemote { .. } => {
                result.deleted_remote += 1;
            }
            SyncAction::Conflict { .. } => {
                result.conflicts += 1;
            }
            SyncAction::DeleteLocal { key } => {
                delete_local_file(key, local_files, &data_dir, result);
            }
            SyncAction::DownloadNew { .. } | SyncAction::DownloadModified { .. } => {}
        }
    }

    unwritten
}

/// Deletes locally a file that was deleted on remote.
///
/// A round trip to the server sits between the scan's verdict and here. An edit written
/// in that gap is known to nobody yet, so the content is hashed again right before the
/// delete, and the file is kept if it differs from the scan.
/// A kept file comes back as `UploadModified` on the next sync
fn delete_local_file(
    key: &str,
    local_files: &[LocalFile],
    data_dir: &Path,
    result: &mut SyncResult,
) {
    let path = data_dir.join(key);
    let content = match fs::read(&path) {
        Ok(content) => content,
        // Already gone: that just saved the trouble of deleting it
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            result.deleted_local += 1;
            return;
        }
        Err(e) => {
            result.errors.push(SyncIssue::DeleteFailed {
                key: key.to_string(),
                detail: e.to_string(),
            });
            return;
        }
    };

    let scanned = local_files
        .iter()
        .find(|f| f.key == key)
        .map(|f| f.content_hash.as_str());
    if scanned != Some(scan::compute_hash(&content).as_str()) {
        result.errors.push(SyncIssue::DeleteSkippedChanged {
            key: key.to_string(),
        });
        return;
    }

    if let Err(e) = fs::remove_file(&path) {
        result.errors.push(SyncIssue::DeleteFailed {
            key: key.to_string(),
            detail: e.to_string(),
        });
    } else {
        result.deleted_local += 1;
    }
}

/// Saves the state the server settled on, narrowed to the files actually on disk.
/// Recording a file not on disk as "synced" deletes the remote side on the next sync.
/// `unwritten` holds the keys whose fetch failed: the file itself is still there at the
/// old version, so an existence check alone cannot exclude it.
///
/// A key whose fetch failed keeps its record from `previous` (the state read before the
/// sync). What is on disk is the version seen last time, so that is also the real state.
/// Dropping the record makes the next sync fall into "no state, present on both sides,
/// hashes differ", that is Conflict, and a conflict copy appears where a re-fetch would do.
/// When `previous` has no record (a failure on the first sync), dropping is right:
/// nobody knows the local version, so there is nothing to match it against.
fn to_local_state(
    server_state: &ServerSyncState,
    data_dir: &Path,
    unwritten: &HashSet<String>,
    previous: &SyncState,
) -> SyncState {
    let mut state = SyncState {
        last_sync: Some(Utc::now()),
        ..Default::default()
    };
    for (key, record) in &server_state.files {
        if !is_safe_key(key) || !data_dir.join(key).exists() {
            continue;
        }
        if unwritten.contains(key) {
            if let Some(kept) = previous.files.get(key) {
                state.files.insert(key.clone(), kept.clone());
            }
            continue;
        }
        let Ok(last_synced_modified) = record.last_modified.parse() else {
            continue;
        };
        state.files.insert(
            key.clone(),
            FileSyncRecord {
                last_synced_modified,
                content_hash: record.hash.clone(),
            },
        );
    }
    state
}

fn save_local_state(
    base_dir: &Path,
    server_state: &ServerSyncState,
    data_dir: &Path,
    unwritten: &HashSet<String>,
    previous: &SyncState,
) -> Result<(), String> {
    to_local_state(server_state, data_dir, unwritten, previous)
        .save(base_dir)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::client::ServerFileRecord;

    fn local_file(key: &str, hash: &str) -> LocalFile {
        LocalFile {
            key: key.to_string(),
            last_modified: "2026-08-05T00:00:00Z".parse().unwrap(),
            content_hash: hash.to_string(),
        }
    }

    fn server_state(entries: &[(&str, &str, &str)]) -> ServerSyncState {
        ServerSyncState {
            files: entries
                .iter()
                .map(|(key, hash, last_modified)| {
                    (
                        (*key).to_string(),
                        ServerFileRecord {
                            hash: (*hash).to_string(),
                            last_modified: (*last_modified).to_string(),
                        },
                    )
                })
                .collect(),
            last_sync: None,
            etag: None,
        }
    }

    /// Every test passes the same `base_dir` as the app. Sync touches only the `data/`
    /// under it, so that is where files are placed.
    fn seed(base_dir: &Path, key: &str, content: &str) {
        let path = paths::data_dir(base_dir).join(key);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// The server rejects an upload without a hash with 400
    #[test]
    fn upload_carries_the_local_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "hello");
        let locals = vec![local_file("notes/a.md", "deadbeef")];
        let actions = vec![SyncAction::UploadNew {
            key: "notes/a.md".to_string(),
        }];

        let mut result = SyncResult::default();
        let req = build_bulk_request(
            &actions,
            &locals,
            &paths::data_dir(dir.path()),
            None,
            &mut result,
        )
        .unwrap();

        assert_eq!(req.uploads.len(), 1);
        assert_eq!(req.uploads[0].hash, "deadbeef");
        assert_eq!(req.uploads[0].content_base64, B64.encode(b"hello"));
    }

    #[test]
    fn conflict_sends_local_content_so_the_local_edit_wins() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "local edit");
        let locals = vec![local_file("notes/a.md", "hash-local")];
        let actions = vec![SyncAction::Conflict {
            key: "notes/a.md".to_string(),
        }];

        let mut result = SyncResult::default();
        let req = build_bulk_request(
            &actions,
            &locals,
            &paths::data_dir(dir.path()),
            None,
            &mut result,
        )
        .unwrap();

        assert_eq!(req.conflicts.len(), 1);
        assert_eq!(req.conflicts[0].hash, "hash-local");
        assert_eq!(req.conflicts[0].content_base64, B64.encode(b"local edit"));
        assert!(req.conflicts[0].conflict_key.contains(".sync-conflict-"));
    }

    #[test]
    fn local_state_mirrors_what_the_server_recorded() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "content");
        let state = server_state(&[("notes/a.md", "hash-a", "2026-08-05T00:00:00Z")]);

        let local = to_local_state(
            &state,
            &paths::data_dir(dir.path()),
            &HashSet::new(),
            &SyncState::default(),
        );

        let record = &local.files["notes/a.md"];
        assert_eq!(record.content_hash, "hash-a");
        assert_eq!(
            record.last_synced_modified,
            "2026-08-05T00:00:00Z".parse::<DateTime<Utc>>().unwrap()
        );
    }

    /// Recording a file not on disk as "synced" makes the next sync treat the remote
    /// side as deleted and remove it
    #[test]
    fn local_state_drops_files_that_are_not_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let state = server_state(&[("notes/missing.md", "hash-a", "2026-08-05T00:00:00Z")]);

        assert!(
            to_local_state(
                &state,
                &paths::data_dir(dir.path()),
                &HashSet::new(),
                &SyncState::default()
            )
            .files
            .is_empty()
        );
    }

    #[test]
    fn local_state_drops_unsafe_keys() {
        let dir = tempfile::tempdir().unwrap();
        let state = server_state(&[("../escape.md", "hash-a", "2026-08-05T00:00:00Z")]);

        assert!(
            to_local_state(
                &state,
                &paths::data_dir(dir.path()),
                &HashSet::new(),
                &SyncState::default()
            )
            .files
            .is_empty()
        );
    }

    /// What escapes is the path component `..`, not dots next to each other in a name.
    /// Copies from before server-driven sync can carry a name with one dot too many,
    /// such as `<stem>.sync-conflict-20260511-031336..md`, and rejecting on a substring
    /// match would make every sync fail with "unsafe name".
    #[test]
    fn a_doubled_dot_inside_a_filename_is_not_traversal() {
        assert!(is_safe_key(
            "projects/a/done/20260417_023550.sync-conflict-20260511-031336..md"
        ));
        assert!(is_safe_key("notes/..md"));

        assert!(!is_safe_key("../escape.md"));
        assert!(!is_safe_key("notes/../../escape.md"));
        assert!(!is_safe_key("/etc/passwd"));
        assert!(!is_safe_key("notes/a\0.md"));
    }

    #[test]
    fn applying_the_response_writes_downloads_and_conflict_copies() {
        let dir = tempfile::tempdir().unwrap();
        let resp = BulkResponse {
            downloads: vec![DownloadedFile {
                key: "notes/a.md".to_string(),
                content_base64: B64.encode(b"remote"),
            }],
            conflict_downloads: vec![DownloadedFile {
                key: "notes/a.sync-conflict-20260805-000000.md".to_string(),
                content_base64: B64.encode(b"other device"),
            }],
            new_state: server_state(&[]),
        };

        let mut result = SyncResult::default();
        apply_response(&resp, &[], &[], dir.path(), &mut result);

        let data = paths::data_dir(dir.path());
        assert_eq!(
            fs::read_to_string(data.join("notes/a.md")).unwrap(),
            "remote"
        );
        // A copy is not a note that keeps being written. Put in `data/notes/`, it would
        // appear in the note list even while excluded from sync, and remain as a
        // leftover after the original note is gone
        assert!(
            !data
                .join("notes/a.sync-conflict-20260805-000000.md")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(paths::conflicts_dir(dir.path()).join("notes/a/20260805-000000.md"))
                .unwrap(),
            "other device"
        );
        assert_eq!(result.downloaded, 1);
    }

    /// When one write fails after the bulk went through, the rest still gets written
    /// instead of bailing out. Bailing out would never reach `save_local_state`, and
    /// one broken key would stop every sync at the same spot. The failed key keeps its
    /// previous record, so the next sync can redo it as a Download rather than a Conflict
    #[test]
    fn a_failed_download_is_retried_as_a_download_next_time() {
        let dir = tempfile::tempdir().unwrap();
        // The fetch of the updated version failed, so the old version is still on disk
        seed(dir.path(), "notes/bad.md", "stale local copy");
        // The last sync saw the old version through
        let previous = SyncState {
            files: HashMap::from([(
                "notes/bad.md".to_string(),
                FileSyncRecord {
                    last_synced_modified: "2026-08-01T00:00:00Z".parse().unwrap(),
                    content_hash: "hash-stale".to_string(),
                },
            )]),
            last_sync: None,
        };
        let resp = BulkResponse {
            downloads: vec![
                DownloadedFile {
                    key: "notes/bad.md".to_string(),
                    content_base64: "not base64!!".to_string(),
                },
                DownloadedFile {
                    key: "notes/good.md".to_string(),
                    content_base64: B64.encode(b"remote"),
                },
            ],
            conflict_downloads: Vec::new(),
            new_state: server_state(&[
                ("notes/bad.md", "hash-bad", "2026-08-05T00:00:00Z"),
                ("notes/good.md", "hash-good", "2026-08-05T00:00:00Z"),
            ]),
        };

        let mut result = SyncResult::default();
        let unwritten = apply_response(&resp, &[], &[], dir.path(), &mut result);

        let data = paths::data_dir(dir.path());
        assert_eq!(
            fs::read_to_string(data.join("notes/good.md")).unwrap(),
            "remote"
        );
        assert_eq!(
            fs::read_to_string(data.join("notes/bad.md")).unwrap(),
            "stale local copy"
        );
        assert_eq!(result.downloaded, 1);
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);

        // Recording the key that could not be fetched as "synced" would settle the old
        // local version under the new hash. Instead the previous record stays as it was
        let state = to_local_state(&resp.new_state, &data, &unwritten, &previous);
        assert_eq!(state.files["notes/good.md"].content_hash, "hash-good");
        let kept = &state.files["notes/bad.md"];
        assert_eq!(kept.content_hash, "hash-stale");
        assert_eq!(
            kept.last_synced_modified,
            "2026-08-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap()
        );

        // Thanks to that record, the next sync lands on "local unchanged, remote
        // changed". Dropping it would give "present on both sides, hashes differ" with
        // no state, that is Conflict, and one more conflict copy
        let next = diff::compute(
            &[local_file("notes/bad.md", "hash-stale")],
            &[RemoteFile {
                key: "notes/bad.md".to_string(),
                last_modified: "2026-08-05T00:00:00Z".parse().unwrap(),
                content_hash: "hash-bad".to_string(),
            }],
            &state,
        );
        assert_eq!(
            next,
            vec![SyncAction::DownloadModified {
                key: "notes/bad.md".to_string()
            }]
        );
    }

    fn delete_local(key: &str) -> SyncAction {
        SyncAction::DeleteLocal {
            key: key.to_string(),
        }
    }

    fn no_response() -> BulkResponse {
        BulkResponse {
            downloads: Vec::new(),
            conflict_downloads: Vec::new(),
            new_state: server_state(&[]),
        }
    }

    #[test]
    fn a_local_delete_removes_the_file_it_was_computed_from() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "untouched");
        let locals = vec![local_file("notes/a.md", &scan::compute_hash(b"untouched"))];

        let mut result = SyncResult::default();
        apply_response(
            &no_response(),
            &[delete_local("notes/a.md")],
            &locals,
            dir.path(),
            &mut result,
        );

        assert!(!paths::data_dir(dir.path()).join("notes/a.md").exists());
        assert_eq!(result.deleted_local, 1);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
    }

    /// A network round trip sits between the scan and the delete. So an edit written in
    /// that gap is not deleted too, the content is checked again right before the delete
    #[test]
    fn a_local_delete_is_skipped_when_the_file_changed_after_the_scan() {
        let dir = tempfile::tempdir().unwrap();
        seed(
            dir.path(),
            "notes/a.md",
            "edited while the sync was in flight",
        );
        let locals = vec![local_file("notes/a.md", &scan::compute_hash(b"as scanned"))];

        let mut result = SyncResult::default();
        apply_response(
            &no_response(),
            &[delete_local("notes/a.md")],
            &locals,
            dir.path(),
            &mut result,
        );

        assert_eq!(
            fs::read_to_string(paths::data_dir(dir.path()).join("notes/a.md")).unwrap(),
            "edited while the sync was in flight"
        );
        assert_eq!(result.deleted_local, 0);
        // Both the app (Japanese) and the CLI (English) display it, so the reason comes
        // back as a key, not an English sentence
        assert_eq!(
            result.errors,
            vec![SyncIssue::DeleteSkippedChanged {
                key: "notes/a.md".to_string()
            }]
        );
    }

    /// When the server's sync state is corrupt and empty, this keeps it from being read
    /// as "everything was deleted" and wiping the notes
    #[test]
    fn refuses_a_sync_that_would_delete_every_local_file() {
        let locals = vec![
            local_file("notes/a.md", "h1"),
            local_file("notes/b.md", "h2"),
            local_file("notes/c.md", "h3"),
        ];
        let actions = vec![
            delete_local("notes/a.md"),
            delete_local("notes/b.md"),
            delete_local("notes/c.md"),
        ];

        let err = refuse_wholesale_local_deletion(&actions, &locals).unwrap_err();
        assert_eq!(err.kind, "unsafeDeletion");
    }

    #[test]
    fn allows_deleting_some_of_the_local_files() {
        let locals = vec![
            local_file("notes/a.md", "h1"),
            local_file("notes/b.md", "h2"),
            local_file("notes/c.md", "h3"),
        ];
        let actions = vec![delete_local("notes/a.md"), delete_local("notes/b.md")];

        assert!(refuse_wholesale_local_deletion(&actions, &locals).is_ok());
    }

    /// With only a few files it can be recovered from, so it is let through
    #[test]
    fn allows_clearing_a_tiny_workspace() {
        let locals = vec![local_file("notes/a.md", "h1")];
        let actions = vec![delete_local("notes/a.md")];

        assert!(refuse_wholesale_local_deletion(&actions, &locals).is_ok());
    }

    /// One below the threshold (3). A wholesale delete of 2 is still on the "recoverable" side.
    #[test]
    fn allows_clearing_a_workspace_just_below_the_threshold() {
        let locals = vec![
            local_file("notes/a.md", "h1"),
            local_file("notes/b.md", "h2"),
        ];
        let actions = vec![delete_local("notes/a.md"), delete_local("notes/b.md")];

        assert_eq!(locals.len(), WHOLESALE_DELETION_THRESHOLD - 1);
        assert!(refuse_wholesale_local_deletion(&actions, &locals).is_ok());
    }

    /// The lock is taken at the entry. Going on to the scan or HTTP without it would
    /// read a state the other process is in the middle of writing.
    /// The destination is unreachable, so if it got as far as the network, kind would be `network`.
    #[tokio::test]
    async fn a_held_lock_stops_the_run_before_it_talks_to_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let held = SyncLock::acquire(dir.path()).unwrap();

        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let err = run(&client, dir.path()).await.unwrap_err();

        assert_eq!(err.kind, "busy");
        drop(held);
    }

    /// One broken note's worth. Only the remains of an opening fence, a line that reads
    /// as a time, and a closing line of dashes together count as "garbled metadata"
    /// (`note/repair.rs`). The reproduction of the file that was actually broken is there.
    const MANGLED: &str = concat!(
        "---\n",
        "time: 2026-05-03T15:39:10+09:00\n",
        "tags: []\n",
        "---\n",
        "***\n",
        "\n",
        "time: 2026-05-03T15:47:06+09:00\n",
        "------\n",
        "\n",
        "# 本文\n",
    );

    /// The repair runs before the scan and inside the lock. When it ran outside, the tree
    /// could be rewritten while the other process was scanning it (#250).
    /// The destination is unreachable, so if it is repaired, the repair ran before the network.
    #[tokio::test]
    async fn the_run_entry_repairs_the_tree_once_it_holds_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        // A conflict copy an old version put in `data/`. If the scan picks it up, the
        // leftover is handed to every device
        let leftover = "notes/20260320_033440.sync-conflict-20260511-031336.md";
        seed(dir.path(), leftover, "leftover");
        seed(dir.path(), "notes/20260320_033440.md", "the note");
        seed(dir.path(), "notes/20260503_153910.md", MANGLED);

        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let _ = run(&client, dir.path()).await;

        let data = paths::data_dir(dir.path());
        assert!(
            !data.join(leftover).exists(),
            "競合コピーが data/ に残っている"
        );
        assert!(
            paths::conflicts_dir(dir.path())
                .join("notes/20260320_033440/20260511-031336.md")
                .exists()
        );
        assert!(
            data.join("notes/20260320_033440.md").exists(),
            "本体は動かさない"
        );
        let repaired = fs::read_to_string(data.join("notes/20260503_153910.md")).unwrap();
        assert!(
            !repaired.contains("***"),
            "化けたメタデータが残っている:\n{repaired}"
        );
    }

    /// The duplicate-ID cleanup that ran after the sync moves inside too. Outside, the
    /// other side starts scanning in the gap after the lock is released.
    #[tokio::test]
    async fn the_run_entry_relocates_an_id_that_landed_in_both_kinds() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/20260320_033440.md", "the offline edit");
        seed(dir.path(), "codex/20260320_033440.md", "the codex");

        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let _ = run(&client, dir.path()).await;

        let data = paths::data_dir(dir.path());
        assert!(!data.join("notes/20260320_033440.md").exists());
        assert!(
            data.join("codex/20260320_033440.md").exists(),
            "Codex 側が本物"
        );
        assert_eq!(
            fs::read_dir(paths::conflicts_dir(dir.path()).join("notes/20260320_033440"))
                .unwrap()
                .count(),
            1
        );
    }

    /// The side that failed to take the lock writes not one byte. Rewriting the tree
    /// while the other side is scanning is exactly what this set out to fix.
    #[tokio::test]
    async fn a_refused_run_does_not_repair_either() {
        let dir = tempfile::tempdir().unwrap();
        let leftover = "notes/20260320_033440.sync-conflict-20260511-031336.md";
        seed(dir.path(), leftover, "leftover");
        let held = SyncLock::acquire(dir.path()).unwrap();

        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let err = run(&client, dir.path()).await.unwrap_err();

        assert_eq!(err.kind, "busy");
        assert!(paths::data_dir(dir.path()).join(leftover).exists());
        drop(held);
    }

    /// The temp file of `write_atomic` remains in `<base>` after a crash mid-write.
    /// Nobody deletes it, so the sync entry, which holds the lock, picks it up
    #[tokio::test]
    async fn the_run_entry_sweeps_temp_files_left_by_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(".sync-tmp-999-0");
        let in_flight = dir.path().join(".sync-tmp-1000-0");
        fs::write(&stale, "half written").unwrap();
        fs::write(&in_flight, "being renamed right now").unwrap();
        set_age(&stale, STALE_TMP_AGE * 2);

        // An unreachable destination. The sweep is right after the lock, before the network
        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let _ = run(&client, dir.path()).await;

        assert!(!stale.exists());
        // Deleting a file another write is about to rename right now makes that save
        // fail
        assert!(in_flight.exists());
    }

    fn set_age(path: &Path, age: std::time::Duration) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - age)
            .unwrap();
    }

    #[test]
    fn applying_the_response_rejects_a_traversal_key_from_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let resp = BulkResponse {
            downloads: vec![DownloadedFile {
                key: "../escaped.md".to_string(),
                content_base64: B64.encode(b"evil"),
            }],
            conflict_downloads: Vec::new(),
            new_state: server_state(&[]),
        };

        let mut result = SyncResult::default();
        let unwritten = apply_response(&resp, &[], &[], dir.path(), &mut result);

        assert!(!dir.path().join("escaped.md").exists());
        assert_eq!(result.downloaded, 0);
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);
        assert!(unwritten.contains("../escaped.md"));
    }

    // ──────────── sync across rounds ────────────

    /// A stand-in for the server. Like R2 it counts one operation per file, and it
    /// remembers how many each bulk spent. Whether the split fits the budget can only be
    /// seen at the receiving end.
    #[derive(Default)]
    struct FakeStore {
        /// key -> (content, hash, `last_modified`)
        files: HashMap<String, (Vec<u8>, String, String)>,
        bulk_ops: Vec<usize>,
        uploaded_keys: Vec<String>,
        /// Stands in for a state where nothing can be written locally (read-only, out of space).
        /// Returning broken base64 sends `apply_response` down the same path
        corrupt_downloads: bool,
    }

    struct FakeServer {
        store: std::sync::Mutex<FakeStore>,
    }

    impl FakeServer {
        fn new() -> Self {
            Self {
                store: std::sync::Mutex::new(FakeStore::default()),
            }
        }

        fn corrupting_downloads() -> Self {
            let server = Self::new();
            server.store.lock().unwrap().corrupt_downloads = true;
            server
        }

        fn put(&self, key: &str, content: &str, last_modified: &str) {
            self.store.lock().unwrap().files.insert(
                key.to_string(),
                (
                    content.as_bytes().to_vec(),
                    scan::compute_hash(content.as_bytes()),
                    last_modified.to_string(),
                ),
            );
        }

        fn content(&self, key: &str) -> Option<String> {
            let content = {
                let store = self.store.lock().unwrap();
                store.files.get(key).map(|(content, _, _)| content.clone())
            };
            Some(String::from_utf8(content?).unwrap())
        }

        fn bulk_ops(&self) -> Vec<usize> {
            self.store.lock().unwrap().bulk_ops.clone()
        }

        fn uploaded_keys(&self) -> Vec<String> {
            self.store.lock().unwrap().uploaded_keys.clone()
        }
    }

    fn wire_state(files: &HashMap<String, (Vec<u8>, String, String)>) -> ServerSyncState {
        ServerSyncState {
            files: files
                .iter()
                .map(|(key, (_, hash, last_modified))| {
                    (
                        key.clone(),
                        ServerFileRecord {
                            hash: hash.clone(),
                            last_modified: last_modified.clone(),
                        },
                    )
                })
                .collect(),
            last_sync: None,
            etag: None,
        }
    }

    // Not `async fn`, since there is nothing to await. With a synchronous body, `ready`
    // also shows at a glance that no lock is held across a future
    impl SyncTransport for FakeServer {
        fn get_sync_state(
            &self,
        ) -> impl std::future::Future<Output = Result<ServerSyncState, SyncError>> + Send {
            let state = {
                let store = self.store.lock().unwrap();
                ServerSyncState {
                    etag: Some("etag".to_string()),
                    ..wire_state(&store.files)
                }
            };
            std::future::ready(Ok(state))
        }

        fn bulk(
            &self,
            req: BulkRequest,
        ) -> impl std::future::Future<Output = Result<BulkResponse, SyncError>> + Send {
            std::future::ready(Ok(self.apply_bulk(&req)))
        }
    }

    impl FakeServer {
        fn apply_bulk(&self, req: &BulkRequest) -> BulkResponse {
            let mut store = self.store.lock().unwrap();
            // Copies the Worker's counting as is. A conflict is get + put to set aside
            // and a put to overwrite; remote deletes are 1 however many
            store.bulk_ops.push(
                req.uploads.len()
                    + req.downloads.len()
                    + req.conflicts.len() * 3
                    + usize::from(!req.delete_remote.is_empty()),
            );

            for up in &req.uploads {
                store.uploaded_keys.push(up.key.clone());
                let content = B64.decode(&up.content_base64).unwrap();
                store.files.insert(
                    up.key.clone(),
                    (content, up.hash.clone(), up.last_modified.clone()),
                );
            }

            let downloads: Vec<DownloadedFile> = req
                .downloads
                .iter()
                .filter_map(|key| {
                    let (content, _, _) = store.files.get(key)?;
                    Some(DownloadedFile {
                        key: key.clone(),
                        content_base64: if store.corrupt_downloads {
                            "not base64!!".to_string()
                        } else {
                            B64.encode(content)
                        },
                    })
                })
                .collect();

            for key in &req.delete_remote {
                store.files.remove(key);
            }

            let mut conflict_downloads = Vec::new();
            for op in &req.conflicts {
                if let Some(previous) = store.files.get(&op.key).cloned() {
                    conflict_downloads.push(DownloadedFile {
                        key: op.conflict_key.clone(),
                        content_base64: B64.encode(&previous.0),
                    });
                    store.files.insert(op.conflict_key.clone(), previous);
                }
                let content = B64.decode(&op.content_base64).unwrap();
                store.files.insert(
                    op.key.clone(),
                    (content, op.hash.clone(), op.last_modified.clone()),
                );
            }

            BulkResponse {
                downloads,
                conflict_downloads,
                new_state: wire_state(&store.files),
            }
        }
    }

    /// This is the Mac right after an import. Putting everything in one bulk crashes the
    /// Worker on the Free plan's subrequest limit, and no retry ever gets through.
    #[tokio::test]
    async fn a_hundred_uploads_go_in_rounds_that_each_fit_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..100 {
            seed(
                dir.path(),
                &format!("notes/{i:03}.md"),
                &format!("body {i}"),
            );
        }
        let server = FakeServer::new();
        let mut rounds = Vec::new();

        let result = run_over(&server, dir.path(), 40, |p| {
            rounds.push((p.round, p.done, p.remaining));
        })
        .await
        .unwrap();

        assert_eq!(result.uploaded, 100);
        assert_eq!(rounds, [(1, 40, 60), (2, 40, 20), (3, 20, 0)]);
        assert_eq!(server.bulk_ops(), [40, 40, 20]);
        assert_eq!(server.content("notes/099.md").as_deref(), Some("body 99"));
    }

    /// **The core is how a carried-over key is recorded.** Writing a download moved to
    /// the next round as "synced at the server's version" makes the old version still
    /// on disk look like "a local edit" in the next round. The download turns into an
    /// upload and crushes the new version it was meant to fetch.
    #[tokio::test]
    async fn a_download_carried_to_the_next_round_does_not_become_an_upload() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::new();
        let mut state = SyncState::default();
        for i in 0..45 {
            let key = format!("notes/{i:03}.md");
            seed(dir.path(), &key, "old");
            server.put(&key, &format!("new {i}"), "2026-08-05T00:00:00Z");
            state.files.insert(
                key,
                FileSyncRecord {
                    last_synced_modified: "2026-08-01T00:00:00Z".parse().unwrap(),
                    content_hash: scan::compute_hash(b"old"),
                },
            );
        }
        state.save(dir.path()).unwrap();

        let result = run_over(&server, dir.path(), 40, |_| {}).await.unwrap();

        assert_eq!(result.downloaded, 45);
        assert_eq!(result.uploaded, 0);
        assert!(
            server.uploaded_keys().is_empty(),
            "持ち越した 5 件が古い版で押し返された: {:?}",
            server.uploaded_keys()
        );
        let data = paths::data_dir(dir.path());
        for i in 0..45 {
            assert_eq!(
                fs::read_to_string(data.join(format!("notes/{i:03}.md"))).unwrap(),
                format!("new {i}")
            );
        }
    }

    /// Progress is measured by the number settled, not the number sent.
    ///
    /// When nothing can be written locally (read-only, out of space), all 40 chosen
    /// fail and the record does not advance. The next round picks the same 40 by key
    /// order, so counting by sent would repeat 200 rounds while claiming "progress",
    /// and the remaining 5 would never be reached.
    #[tokio::test]
    async fn a_round_where_nothing_could_be_written_stops_instead_of_spinning() {
        let dir = tempfile::tempdir().unwrap();
        let server = FakeServer::corrupting_downloads();
        let mut state = SyncState::default();
        for i in 0..45 {
            let key = format!("notes/{i:03}.md");
            seed(dir.path(), &key, "old");
            server.put(&key, &format!("new {i}"), "2026-08-05T00:00:00Z");
            state.files.insert(
                key,
                FileSyncRecord {
                    last_synced_modified: "2026-08-01T00:00:00Z".parse().unwrap(),
                    content_hash: scan::compute_hash(b"old"),
                },
            );
        }
        state.save(dir.path()).unwrap();

        let err = run_over(&server, dir.path(), 40, |_| {}).await.unwrap_err();

        assert_eq!(err.kind, "stalled");
        assert_eq!(
            server.bulk_ops().len(),
            1,
            "1 round で見切りをつける。200 回ぶんの往復を Free プランに投げない"
        );
    }

    /// A round that sends nothing while something is left to send comes out the same
    /// however often it runs. It is the only way into an infinite loop, so it stops here.
    #[tokio::test]
    async fn a_round_that_sends_nothing_stops_the_sync() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "body");
        let server = FakeServer::new();

        let err = run_over(&server, dir.path(), 0, |_| {}).await.unwrap_err();

        assert_eq!(err.kind, "stalled");
    }
}
