//! 同期の本体。呼び出し元が増えても 1 本しかない実装。
//! 呼ぶのはアプリと CLI の `sync` の 2 つ。
//!
//! ここに書かれた不変条件（自分の state を送り返さない、ダウンロード後に
//! 再スキャンで state を組み直さない、全消しを拒否する）はコメントでしか
//! 守られていない。2 本目を書くと必ずドリフトするので分岐させない。

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

/// 1 回の同期で回す round の上限。予算より高くつく action は無い
/// (競合の 3 でも予算 40 に収まる) ので、ここに当たるのはバグのとき。
/// 進まない round はその場で `stalled` になるが、念のための天井。
const MAX_ROUNDS: usize = 200;

/// round が 1 つ終わるたびに呼ばれる。進捗を出すのは CLI だけで、アプリは
/// spinner を回したままにする。
#[derive(Debug, Clone, Copy)]
pub struct RoundProgress {
    /// 1 から数えた round の番号。全体で何 round になるかは、やってみるまで
    /// 分からない — 途中で他端末が書けば増える
    pub round: usize,
    /// この round で送った action の数
    pub done: usize,
    /// 予算に入らず次に回した action の数
    pub remaining: usize,
}

/// 1 回の同期。呼び出し側は認証済みの `HttpClient` を渡す。
pub async fn run(client: &HttpClient, base_dir: &Path) -> Result<SyncResult, SyncError> {
    run_over(client, base_dir, BULK_OPERATION_BUDGET, |_| {}).await
}

/// round ごとに知らせる版。何百本を送るときに、止まって見えないようにする。
pub async fn run_with_progress<F: FnMut(RoundProgress)>(
    client: &HttpClient,
    base_dir: &Path,
    on_round: F,
) -> Result<SyncResult, SyncError> {
    run_over(client, base_dir, BULK_OPERATION_BUDGET, on_round).await
}

/// 本体。`HttpClient` ではなく `SyncTransport` を取るのも、予算を引数に
/// するのもテストのため — 公開する口は上の 2 つに保つ。
async fn run_over<T: SyncTransport + Sync, F: FnMut(RoundProgress)>(
    client: &T,
    base_dir: &Path,
    budget: usize,
    mut on_round: F,
) -> Result<SyncResult, SyncError> {
    // 同じデータディレクトリを見ている別のプロセスと同時に走ると、
    // 最後に書いたほうの `.sync-state.json` が残って相手の記録が消える。
    // 再試行のあいだも手放さないので、ここで 1 回だけ取る。
    // 名前付きで束縛すること: `let _ = ` だとその場で解放されてしまう
    let _lock = SyncLock::acquire(base_dir)?;

    sweep_stale_temp_files(base_dir);

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
    // 途中で止めても壊れない: round ごとに state は書けているので、
    // 送り終えたぶんは次の同期でやり直しにならない
    Err(stalled(&format!(
        "Sync gave up after {MAX_ROUNDS} rounds. What it managed to send is kept; \
         run it again to continue."
    )))
}

/// 回り続けても終わらない、と分かったとき。予算に収まらない action は
/// 無い(競合の 3 でも 40 に入る)ので、ここに来るのはバグか、同じキーで
/// 詰まり続けているとき。黙って回り続けるより止めて見せる。
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

/// 1 round ぶんの結果と、まだ残っている数。
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
    // 他端末と同時に同期すると CAS で弾かれる。ユーザーに再試行させる理由はないので
    // 取得し直して自動でやり直す
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

    // 全消しの判定は毎 round、分ける前の全部で行う。分けたあとだと、
    // 40 件ずつの「一部削除」に見えて歯止めが効かない
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
    // 同期そのものが止まる側。CLI もアプリの汎用エラー表示も英文で扱う
    .map_err(|issue| SyncError::other(issue.to_string()))?;

    let bulk_resp = client.bulk(bulk_req).await?;

    let unwritten = apply_response(&bulk_resp, &actions, &local_files, base_dir, &mut result);

    // 送った数ではなく、片付いた数を進み具合とする。書き込みに失敗した
    // キーは次の round でも同じ順に選ばれるので、送った数で数えると
    // 「進んでいる」と言いながら同じ 40 件を 200 round 繰り返す
    let settled = actions
        .iter()
        .filter(|a| !unwritten.contains(a.key()))
        .count();

    let mut unsettled = unwritten;
    // 次の round に回したキーも、取得に失敗したキーと同じ扱いにする。
    // サーバーが確定させた版で記録してしまうと、手元にあるのは古い版なので
    // 次の round には「ローカルの編集」に見え、取りに行くはずだった
    // ダウンロードがアップロードに化けて新しい版を潰す
    unsettled.extend(deferred.iter().map(|a| a.key().to_string()));

    // サーバーが確定させた状態をそのままローカルにも記録する。
    // ここでローカルを再スキャンして組み直すと、ダウンロード直後の mtime が
    // サーバーの版と食い違い、同じファイルを永久に再取得し続ける

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

/// これより古い `.sync-tmp-*` は、書き手が落ちて置き去りにしたものと見なす。
/// 生きている書き込みは `fs::write` から `rename` までの一瞬しか持たない
const STALE_TMP_AGE: std::time::Duration = std::time::Duration::from_hours(1);

/// `write_atomic` の一時ファイルは rename の前にプロセスが落ちると残る。
/// `<base>` 直下のものは誰の掃除対象でもないので、ここで拾う。
///
/// 年齢で絞るのは、いま別の書き込みが rename を待っている一時ファイルを
/// 消さないため — 消すとその保存が失敗する。掃除に失敗しても同期には
/// 関係がないので黙って進む。
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

/// data ディレクトリの外を指せないキーか。
///
/// 危ないのは `..` という**パス要素**であって、名前の中に並んだ点ではない。
/// 部分一致で弾くと `….sync-conflict-20260511-031336..md`(サーバー駆動同期
/// 以前の控えにある、点が 1 つ多い名前)まで巻き込み、その控えを抱えた端末は
/// 毎回の同期が失敗し続ける。`Path` に読ませれば区切りの解釈は OS に合う。
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
                // ローカル削除は client 側だけで完結（bulk request には含めない）
            }
            SyncAction::Conflict { key } => {
                // 双方が変わっていたらローカルを採用する。捨てたほうも競合コピーとして
                // 残るので、どちらの編集も失われない
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
    // 直接上書きだと、ダウンロード書き込み中のクラッシュで手元のメモが
    // 半分だけ書けたファイルに置き換わる
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

/// サーバーの返事をローカルに反映する。書けなかったキーを返す。
///
/// 1 件の失敗でここを抜けると `save_local_state` に届かず、壊れたキーが
/// 毎回同じ所で同期を止める。失敗は `result.errors` に積んで先へ進み、
/// 書けなかったキーは「同期済み」として記録させない。
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

    // 競合で負けたリモート側。`data/` の外に置くので同期にも載らず、
    // ノート一覧にも並ばない。
    // 失敗しても `unwritten` には入れない: 控えのキーは state に載らないので、
    // 入れたところで何も除けない（サーバー側の控えは残るので中身も失われない）
    let conflicts_dir = paths::conflicts_dir(base_dir);
    for d in &bulk_resp.conflict_downloads {
        // 名前が読めなければキーのまま置く。形が古くても控えは控え
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

/// サーバーが確定させた状態を、実際に手元にあるファイルだけに絞って保存する。
/// 手元に無いものを「同期済み」と記録すると、次の同期でリモート側を消してしまう。
/// `unwritten` は取得に失敗したキー: ファイル自体は古い版のまま残っているので、
/// 存在チェックだけでは除けない。
///
/// 取得に失敗したキーには `previous`（同期前に読んだ state）の記録を残す。
/// 手元にあるのは前回見届けたとおりの版なので、それが実際の状態でもある。
/// 記録ごと落とすと次の同期が「state 無し・両側にあり・ハッシュ違い」＝
/// Conflict に落ちて、取り直すだけで済む所に競合コピーが 1 つ増える。
/// `previous` に記録が無い場合（初回同期での失敗）は落とすのが正しい —
/// 手元の版を誰も知らないので、突き合わせる先が無い。
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

    /// テストはどれもアプリと同じ `base_dir` を渡す。同期が触るのはその下の
    /// `data/` だけなので、置くのもそこ。
    fn seed(base_dir: &Path, key: &str, content: &str) {
        let path = paths::data_dir(base_dir).join(key);
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

    /// 手元に無いファイルを「同期済み」と記録すると、次の同期で
    /// リモート側が削除扱いになって消える
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

    /// 抜け出せるのは `..` というパス要素であって、名前の中に並んだ点ではない。
    /// サーバー駆動同期以前の控えには `….sync-conflict-20260511-031336..md` の
    /// ように点が 1 つ多い名前があり、部分一致で弾くと毎回の同期が
    /// 「安全でない名前」で失敗し続ける。
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
        // 控えは書き続けるノートではない。`data/notes/` に置くと同期からは
        // 外れていてもノート一覧に並び、元のノートが消えたあとも残骸として残る
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

    /// bulk が通ったあとの書き込みで 1 件こけたら、そこで抜けずに残りを書く。
    /// 抜けると `save_local_state` に届かず、壊れた 1 キーが毎回同じ所で
    /// 同期を止める。失敗したキーは前回の記録を残し、次の同期が
    /// Conflict ではなく Download としてやり直せるようにする
    #[test]
    fn a_failed_download_is_retried_as_a_download_next_time() {
        let dir = tempfile::tempdir().unwrap();
        // 更新版の取得に失敗したので、手元には古い版が残ったまま
        seed(dir.path(), "notes/bad.md", "stale local copy");
        // 前回の同期は古い版まで見届けている
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

        // 取れなかったキーを「同期済み」と記録すると、手元の古い版が
        // 新しいハッシュで確定してしまう。かわりに前回の記録をそのまま残す
        let state = to_local_state(&resp.new_state, &data, &unwritten, &previous);
        assert_eq!(state.files["notes/good.md"].content_hash, "hash-good");
        let kept = &state.files["notes/bad.md"];
        assert_eq!(kept.content_hash, "hash-stale");
        assert_eq!(
            kept.last_synced_modified,
            "2026-08-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap()
        );

        // その記録があるおかげで、次の同期は「ローカル不変・リモート変更」に
        // 落ちる。落としてしまうと state 無しの「両側にあってハッシュ違い」＝
        // Conflict になり、競合コピーが 1 つ増える
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
            fs::read_to_string(paths::data_dir(dir.path()).join("notes/a.md")).unwrap(),
            "edited while the sync was in flight"
        );
        assert_eq!(result.deleted_local, 0);
        // 表示するのはアプリ (日本語) と CLI (英語) の両方なので、理由は
        // 英文ではなくキーで返す
        assert_eq!(
            result.errors,
            vec![SyncIssue::DeleteSkippedChanged {
                key: "notes/a.md".to_string()
            }]
        );
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

    /// しきい値(3)の 1 つ下。2 件の全消しはまだ「取り返しがつく」側。
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

    /// `write_atomic` の一時ファイルは、書いている途中で落ちると `<base>` に
    /// 残る。誰も消さないので、ロックを持っている同期の入口で拾う
    #[tokio::test]
    async fn the_run_entry_sweeps_temp_files_left_by_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(".sync-tmp-999-0");
        let in_flight = dir.path().join(".sync-tmp-1000-0");
        fs::write(&stale, "half written").unwrap();
        fs::write(&in_flight, "being renamed right now").unwrap();
        set_age(&stale, STALE_TMP_AGE * 2);

        // 到達できない宛先。掃除はロック取得の直後で、通信より前
        let client = HttpClient::new(reqwest::Client::new(), "http://127.0.0.1:1", "token");
        let _ = run(&client, dir.path()).await;

        assert!(!stale.exists());
        // 他の書き込みが今まさに rename しようとしているものを消すと、
        // その保存が失敗する
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

    // ──────────── round をまたぐ同期 ────────────

    /// サーバーの代役。R2 と同じく 1 ファイル 1 操作で数え、bulk 1 回あたり
    /// いくつ使ったかを覚えておく — 予算どおりに切れているかは、送った先で
    /// しか見られない。
    #[derive(Default)]
    struct FakeStore {
        /// key -> (中身, ハッシュ, `last_modified`)
        files: HashMap<String, (Vec<u8>, String, String)>,
        bulk_ops: Vec<usize>,
        uploaded_keys: Vec<String>,
        /// 手元に書けない状況(読み取り専用・容量不足)の代わり。
        /// 壊れた base64 を返せば `apply_response` が同じ道を通る
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

    // 待つものが何も無いので `async fn` にはしない — 中身が同期なら
    // `ready` のほうが、future を跨いでロックを持たないことも一目で分かる
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
            // Worker の数え方をそのまま写す。競合は退避の get + put と
            // 上書きの put、リモート削除は何本でも 1 回
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

    /// 取り込み直後の Mac がこれ。1 本の bulk に全部を載せると Free プランの
    /// サブリクエスト上限で Worker が落ち、何度やっても通らない。
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

    /// **持ち越したキーをどう記録するかが芯。**次の round に回した
    /// ダウンロードを「サーバーの版で同期済み」と書くと、手元に残っている
    /// 古い版が次の round には「ローカルの編集」に見える。ダウンロードが
    /// アップロードに化けて、取りに行くはずだった新しい版を潰す。
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

    /// 送った数ではなく片付いた数で進み具合を測る。
    ///
    /// 手元に 1 件も書けない状況(読み取り専用・容量不足)だと、選ばれた
    /// 40 件はどれも失敗して記録も進まない。次の round はキー順で同じ
    /// 40 件を選ぶので、送った数で数えていると「進んでいる」と言いながら
    /// 200 round 繰り返し、残りの 5 件には一度も手が届かない。
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

    /// 送るものが残っているのに 1 件も送れない round は、何度回しても同じ。
    /// 無限ループの唯一の入口なので、ここで止める。
    #[tokio::test]
    async fn a_round_that_sends_nothing_stops_the_sync() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), "notes/a.md", "body");
        let server = FakeServer::new();

        let err = run_over(&server, dir.path(), 0, |_| {}).await.unwrap_err();

        assert_eq!(err.kind, "stalled");
    }
}
