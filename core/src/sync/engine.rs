//! 同期の本体。アプリと CLI で 1 本しかない実装。
//!
//! ここに書かれた不変条件（自分の state を送り返さない、ダウンロード後に
//! 再スキャンで state を組み直さない、全消しを拒否する）はコメントでしか
//! 守られていない。2 本目を書くと必ずドリフトするので分岐させない。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::{DateTime, Utc};

use super::client::{
    BulkRequest, BulkResponse, DownloadedFile, HttpClient, ServerSyncState, WireConflictOp,
    WireUpload,
};
use super::conflict;
use super::diff::{self, RemoteFile, SyncAction};
use super::lock::SyncLock;
use super::scan::{self, LocalFile};
use super::state::{FileSyncRecord, SyncState};
use super::{SyncError, SyncResult};

const MAX_SYNC_ATTEMPTS: usize = 3;

/// 1 回の同期。呼び出し側は認証済みの `HttpClient` を渡す。
pub async fn run(client: &HttpClient, base_dir: &Path) -> Result<SyncResult, SyncError> {
    // 同じデータディレクトリを見ている他のプロセス (アプリと CLI) と同時に走ると、
    // 最後に書いたほうの `.sync-state.json` が残って相手の記録が消える。
    // 再試行のあいだも手放さないので、ここで 1 回だけ取る。
    // 名前付きで束縛すること: `let _ = ` だとその場で解放されてしまう
    let _lock = SyncLock::acquire(base_dir)?;

    // 他端末と同時に同期すると CAS で弾かれる。ユーザーに再試行させる理由はないので
    // 取得し直して自動でやり直す
    for attempt in 1..=MAX_SYNC_ATTEMPTS {
        let outcome = sync_once(client, base_dir).await;
        let retryable =
            matches!(&outcome, Err(err) if err.kind == "conflict") && attempt < MAX_SYNC_ATTEMPTS;
        if !retryable {
            return outcome;
        }
    }
    unreachable!("the loop returns on its last attempt")
}

async fn sync_once(client: &HttpClient, base_dir: &Path) -> Result<SyncResult, SyncError> {
    let server_state = client.get_sync_state().await?;

    let local_files =
        scan::scan_local_files(base_dir).map_err(|e| SyncError::other(e.to_string()))?;
    let local_state = SyncState::load(base_dir).map_err(|e| SyncError::other(e.to_string()))?;

    let remote_files = server_state_to_remote_files(&server_state);
    let actions = diff::compute(&local_files, &remote_files, &local_state);

    refuse_wholesale_local_deletion(&actions, &local_files)?;

    let data_dir = crate::utils::paths::data_dir(base_dir);
    let mut result = SyncResult::default();
    let bulk_req = build_bulk_request(
        &actions,
        &local_files,
        &data_dir,
        server_state.etag.clone(),
        &mut result,
    )
    .map_err(SyncError::other)?;

    let bulk_resp = client.bulk(bulk_req).await?;

    let unwritten = apply_response(&bulk_resp, &actions, &local_files, &data_dir, &mut result);

    // サーバーが確定させた状態をそのままローカルにも記録する。
    // ここでローカルを再スキャンして組み直すと、ダウンロード直後の mtime が
    // サーバーの版と食い違い、同じファイルを永久に再取得し続ける

    save_local_state(base_dir, &bulk_resp.new_state, &data_dir, &unwritten)
        .map_err(SyncError::other)?;

    Ok(result)
}

/// これ以下ならユーザーが本当に消したと考えて素通しする。
/// 1〜2件の全消しは事故が起きても取り返しがつく
const WHOLESALE_DELETION_THRESHOLD: usize = 3;

/// サーバーの同期状態が壊れて空になっていると、差分計算にはローカル全消しに見える。
/// 1回の同期で手元のノートが全部消えるのはまず意図された結果ではないので止める。
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

fn is_safe_key(key: &str) -> bool {
    !key.contains("..") && !key.contains('\0') && !key.starts_with('/')
}

fn build_bulk_request(
    actions: &[SyncAction],
    local_files: &[LocalFile],
    data_dir: &Path,
    expected_etag: Option<String>,
    result: &mut SyncResult,
) -> Result<BulkRequest, String> {
    let local_map: HashMap<&str, &LocalFile> =
        local_files.iter().map(|f| (f.key.as_str(), f)).collect();

    let mut uploads: Vec<WireUpload> = Vec::new();
    let mut downloads: Vec<String> = Vec::new();
    let mut delete_remote: Vec<String> = Vec::new();
    let mut conflicts: Vec<WireConflictOp> = Vec::new();

    for action in actions {
        let key = action_key(action);
        if !is_safe_key(key) {
            result.errors.push(format!("unsafe key rejected: {key}"));
            continue;
        }

        match action {
            SyncAction::UploadNew { key } | SyncAction::UploadModified { key } => {
                let local = local_map
                    .get(key.as_str())
                    .ok_or_else(|| format!("missing local file for upload: {key}"))?;
                let content =
                    fs::read(data_dir.join(key)).map_err(|e| format!("read {key}: {e}"))?;
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
                // ローカル削除は client 側だけで完結（bulk request には含めない）
            }
            SyncAction::Conflict { key } => {
                // 双方が変わっていたらローカルを採用する。捨てたほうも競合コピーとして
                // 残るので、どちらの編集も失われない
                let local = local_map
                    .get(key.as_str())
                    .ok_or_else(|| format!("missing local file for conflict: {key}"))?;
                let content = fs::read(data_dir.join(key))
                    .map_err(|e| format!("read conflict {key}: {e}"))?;
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

fn write_under(data_dir: &Path, key: &str, content: &[u8]) -> Result<(), String> {
    if !is_safe_key(key) {
        return Err(format!("unsafe key from server: {key}"));
    }
    let path = data_dir.join(key);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {key}: {e}"))?;
    }
    // 直接上書きだと、ダウンロード書き込み中のクラッシュで手元のメモが
    // 半分だけ書けたファイルに置き換わる
    crate::utils::fs::write_atomic(&path, content).map_err(|e| format!("write {key}: {e}"))
}

fn decode(file: &DownloadedFile) -> Result<Vec<u8>, String> {
    B64.decode(&file.content_base64)
        .map_err(|e| format!("base64 decode {}: {e}", file.key))
}

/// サーバーの返事をローカルに反映する。書けなかったキーを返す。
///
/// 1 件の失敗でここを抜けると `save_local_state` に届かず、壊れたキーが
/// 毎回同じ所で同期を止める。失敗は `result.errors` に積んで先へ進み、
/// 書けなかったキーは「同期済み」として記録させない。
fn apply_response(
    bulk_resp: &BulkResponse,
    actions: &[SyncAction],
    local_files: &[LocalFile],
    data_dir: &Path,
    result: &mut SyncResult,
) -> HashSet<String> {
    let mut unwritten = HashSet::new();

    for d in &bulk_resp.downloads {
        match decode(d).and_then(|content| write_under(data_dir, &d.key, &content)) {
            Ok(()) => result.downloaded += 1,
            Err(e) => {
                result.errors.push(e);
                unwritten.insert(d.key.clone());
            }
        }
    }

    // 競合で負けたリモート側。`.sync-conflict-` はスキャン対象外なので、
    // ローカルに置いても同期ループにはならない
    for d in &bulk_resp.conflict_downloads {
        if let Err(e) = decode(d).and_then(|content| write_under(data_dir, &d.key, &content)) {
            result.errors.push(e);
            unwritten.insert(d.key.clone());
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
                delete_local_file(key, local_files, data_dir, result);
            }
            SyncAction::DownloadNew { .. } | SyncAction::DownloadModified { .. } => {}
        }
    }

    unwritten
}

/// リモートで消されたファイルをローカルからも消す。
///
/// scan の判定からここまでにサーバーとの往復が挟まる。その隙に書かれた編集は
/// まだ誰も知らないので、削除の直前に中身を数え直し、scan 時と違えば残す。
/// 残ったファイルは次の同期で `UploadModified` として復活する
fn delete_local_file(
    key: &str,
    local_files: &[LocalFile],
    data_dir: &Path,
    result: &mut SyncResult,
) {
    let path = data_dir.join(key);
    let content = match fs::read(&path) {
        Ok(content) => content,
        // すでに無いなら消す手間が省けただけ
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            result.deleted_local += 1;
            return;
        }
        Err(e) => {
            result.errors.push(format!("delete_local {key}: {e}"));
            return;
        }
    };

    let scanned = local_files
        .iter()
        .find(|f| f.key == key)
        .map(|f| f.content_hash.as_str());
    if scanned != Some(scan::compute_hash(&content).as_str()) {
        result
            .errors
            .push(format!("delete_local {key}: changed since scan, kept"));
        return;
    }

    if let Err(e) = fs::remove_file(&path) {
        result.errors.push(format!("delete_local {key}: {e}"));
    } else {
        result.deleted_local += 1;
    }
}

/// サーバーが確定させた状態を、実際に手元にあるファイルだけに絞って保存する。
/// 手元に無いものを「同期済み」と記録すると、次の同期でリモート側を消してしまう。
/// `unwritten` は取得に失敗したキー: ファイル自体は古い版のまま残っているので、
/// 存在チェックだけでは除けない。
fn to_local_state(
    server_state: &ServerSyncState,
    data_dir: &Path,
    unwritten: &HashSet<String>,
) -> SyncState {
    let mut state = SyncState {
        last_sync: Some(Utc::now()),
        ..Default::default()
    };
    for (key, record) in &server_state.files {
        let Ok(last_synced_modified) = record.last_modified.parse() else {
            continue;
        };
        if !is_safe_key(key) || unwritten.contains(key) || !data_dir.join(key).exists() {
            continue;
        }
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
) -> Result<(), String> {
    to_local_state(server_state, data_dir, unwritten)
        .save(base_dir)
        .map_err(|e| e.to_string())
}

fn action_key(action: &SyncAction) -> &str {
    match action {
        SyncAction::UploadNew { key }
        | SyncAction::UploadModified { key }
        | SyncAction::DownloadNew { key }
        | SyncAction::DownloadModified { key }
        | SyncAction::DeleteRemote { key }
        | SyncAction::DeleteLocal { key }
        | SyncAction::Conflict { key } => key,
    }
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

    fn seed(data_dir: &Path, key: &str, content: &str) {
        let path = data_dir.join(key);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// ハッシュが欠けたアップロードはサーバーが 400 で弾く
    #[test]
    fn upload_carries_the_local_content_hash() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "hello");
        let locals = vec![local_file("notes/a.md", "deadbeef")];
        let actions = vec![SyncAction::UploadNew {
            key: "notes/a.md".to_string(),
        }];

        let mut result = SyncResult::default();
        let req = build_bulk_request(&actions, &locals, dir.path(), None, &mut result).unwrap();

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
        let req = build_bulk_request(&actions, &locals, dir.path(), None, &mut result).unwrap();

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

        let local = to_local_state(&state, dir.path(), &HashSet::new());

        let record = &local.files["notes/a.md"];
        assert_eq!(record.content_hash, "hash-a");
        assert_eq!(
            record.last_synced_modified,
            "2026-08-05T00:00:00Z".parse::<DateTime<Utc>>().unwrap()
        );
    }

    /// 手元に無いファイルを「同期済み」と記録すると、次の同期で
    /// リモート側が削除扱いになって消える
    #[test]
    fn local_state_drops_files_that_are_not_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let state = server_state(&[("notes/missing.md", "hash-a", "2026-08-05T00:00:00Z")]);

        assert!(
            to_local_state(&state, dir.path(), &HashSet::new())
                .files
                .is_empty()
        );
    }

    #[test]
    fn local_state_drops_unsafe_keys() {
        let dir = tempfile::tempdir().unwrap();
        let state = server_state(&[("../escape.md", "hash-a", "2026-08-05T00:00:00Z")]);

        assert!(
            to_local_state(&state, dir.path(), &HashSet::new())
                .files
                .is_empty()
        );
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

        assert_eq!(
            fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "remote"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("notes/a.sync-conflict-20260805-000000.md"))
                .unwrap(),
            "other device"
        );
        assert_eq!(result.downloaded, 1);
    }

    /// bulk が通ったあとの書き込みで 1 件こけたら、そこで抜けずに残りを書く。
    /// 抜けると `save_local_state` に届かず、壊れた 1 キーが毎回同じ所で
    /// 同期を止め、次の同期は state 無しで全件 Conflict になる
    #[test]
    fn a_failed_download_leaves_the_others_written_and_the_state_saved() {
        let dir = tempfile::tempdir().unwrap();
        // 更新版の取得に失敗したので、手元には古い版が残ったまま
        seed(dir.path(), "notes/bad.md", "stale local copy");
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

        assert_eq!(
            fs::read_to_string(dir.path().join("notes/good.md")).unwrap(),
            "remote"
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("notes/bad.md")).unwrap(),
            "stale local copy"
        );
        assert_eq!(result.downloaded, 1);
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);

        // 取れなかったキーを「同期済み」と記録すると、手元の古い版が
        // 新しいハッシュで確定してしまう
        let state = to_local_state(&resp.new_state, dir.path(), &unwritten);
        assert!(state.files.contains_key("notes/good.md"));
        assert!(!state.files.contains_key("notes/bad.md"));
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

        assert!(!dir.path().join("notes/a.md").exists());
        assert_eq!(result.deleted_local, 1);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
    }

    /// scan と削除のあいだにはネットワーク往復が挟まる。その隙に書かれた
    /// 編集まで消さないよう、削除の直前に中身を見直す
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
            fs::read_to_string(dir.path().join("notes/a.md")).unwrap(),
            "edited while the sync was in flight"
        );
        assert_eq!(result.deleted_local, 0);
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);
    }

    /// サーバーの同期状態が壊れて空になったときに、それを「全部削除された」と
    /// 解釈してノートを消してしまうのを防ぐ
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

    /// 数件しか無いうちは取り返しがつくので素通しする
    #[test]
    fn allows_clearing_a_tiny_workspace() {
        let locals = vec![local_file("notes/a.md", "h1")];
        let actions = vec![delete_local("notes/a.md")];

        assert!(refuse_wholesale_local_deletion(&actions, &locals).is_ok());
    }

    /// ロックは入口で取る。取れないまま走査や HTTP に進むと、
    /// もう一方のプロセスが書いている最中の状態を読んでしまう。
    /// 到達できない宛先を渡してあるので、通信まで進んでいれば kind は `network` になる。
    #[tokio::test]
    async fn a_held_lock_stops_the_run_before_it_talks_to_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let held = SyncLock::acquire(dir.path()).unwrap();

        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let err = run(&client, dir.path()).await.unwrap_err();

        assert_eq!(err.kind, "busy");
        drop(held);
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

        assert!(!dir.path().parent().unwrap().join("escaped.md").exists());
        assert_eq!(result.downloaded, 0);
        assert_eq!(result.errors.len(), 1, "errors: {:?}", result.errors);
        assert!(unwritten.contains("../escaped.md"));
    }
}
