//! 1 回の bulk に載せる分を切り出す。
//!
//! Workers の Free プランは 1 呼び出しあたりサブリクエスト 50 回までで、
//! bulk を受けた Worker は R2 を 1 ファイルにつき 1 回叩く。529 本の
//! 取り込みを 1 本の bulk で送ると Cloudflare が `Too many subrequests` で
//! 落とし、上限に当たっている限り何度やっても通らない。だから送る側で
//! 予算ぶんに切り、残りは次の round に回す。

use super::diff::SyncAction;

/// 1 回の bulk に載せる R2 操作の上限。数え方は Worker と同じで
/// `upload + download + conflict × 3 + (リモート削除があれば 1)`。
///
/// Free プランの 50 から、Worker が bulk ごとに必ず使う 2 回
/// (state の get と put) を引いた 48 が天井。8 の余裕は、Worker 側の
/// 操作が 1 つ 2 つ増えても古いクライアントが壊れないため。
///
/// サーバーから配らせることはしない。両側の定数にしておけば、値がずれた
/// ときは Worker の 413 で目に見えて止まる — 黙って壊れるより良い。
pub const BULK_OPERATION_BUDGET: usize = 40;

/// `actions` を「今の round で送る分」と「次に回す分」に分ける。
///
/// 順番は競合 → ダウンロード → アップロード。他端末の編集を先に取り込んで
/// から自分のを押すほうが、round をまたぐ間に新しい競合が生まれにくい。
/// 種類の中はキー順で、同じ入力からは必ず同じ分かれ方になる。
#[must_use]
pub fn take_round(actions: &[SyncAction], budget: usize) -> (Vec<SyncAction>, Vec<SyncAction>) {
    let mut ordered: Vec<&SyncAction> = actions.iter().collect();
    ordered.sort_by_key(|a| (rank(a), a.key()));

    let mut round = Vec::new();
    let mut deferred = Vec::new();
    let mut spent = 0;
    let mut deleting_remote = false;

    for action in ordered {
        let cost = cost(action, deleting_remote);
        if spent + cost <= budget {
            deleting_remote |= matches!(action, SyncAction::DeleteRemote { .. });
            spent += cost;
            round.push(action.clone());
        } else {
            deferred.push(action.clone());
        }
    }
    (round, deferred)
}

/// 予算を使わないものから順に。同じ rank の中はキー順に並べる。
const fn rank(action: &SyncAction) -> u8 {
    match action {
        SyncAction::DeleteLocal { .. } => 0,
        SyncAction::DeleteRemote { .. } => 1,
        SyncAction::Conflict { .. } => 2,
        SyncAction::DownloadNew { .. } | SyncAction::DownloadModified { .. } => 3,
        SyncAction::UploadNew { .. } | SyncAction::UploadModified { .. } => 4,
    }
}

/// この action が Worker に使わせる R2 の回数。
///
/// ローカル削除はサーバーに何も頼まない。リモート削除は何本でも
/// `bucket.delete(keys)` 1 回で済むので、2 本目からは 0。競合は退避のため
/// get + put + put で 3 回。
const fn cost(action: &SyncAction, deleting_remote: bool) -> usize {
    match action {
        SyncAction::DeleteLocal { .. } => 0,
        SyncAction::DeleteRemote { .. } => {
            if deleting_remote {
                0
            } else {
                1
            }
        }
        SyncAction::Conflict { .. } => 3,
        SyncAction::UploadNew { .. }
        | SyncAction::UploadModified { .. }
        | SyncAction::DownloadNew { .. }
        | SyncAction::DownloadModified { .. } => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(key: &str) -> SyncAction {
        SyncAction::UploadNew {
            key: key.to_string(),
        }
    }

    fn keys(actions: &[SyncAction]) -> Vec<&str> {
        actions.iter().map(SyncAction::key).collect()
    }

    /// 取り込み直後の Mac がこれ。529 本のアップロードが 1 本の bulk に
    /// なると Worker が落ちるので、予算ぶんで切れていること。
    #[test]
    fn uploads_beyond_the_budget_are_left_for_the_next_round() {
        let actions: Vec<SyncAction> = (0..100)
            .map(|i| upload(&format!("notes/{i:03}.md")))
            .collect();

        let (round, deferred) = take_round(&actions, 40);

        assert_eq!(round.len(), 40);
        assert_eq!(deferred.len(), 60);
        assert_eq!(keys(&round)[0], "notes/000.md");
        assert_eq!(keys(&deferred)[0], "notes/040.md");
    }

    /// 他端末の編集を先に手元へ入れてから自分のを押す。逆だと、取り込んで
    /// いない版の上にアップロードが乗る round が生まれる。
    #[test]
    fn conflicts_come_first_then_downloads_then_uploads() {
        let actions = vec![
            upload("z.md"),
            SyncAction::DownloadNew {
                key: "d.md".to_string(),
            },
            SyncAction::Conflict {
                key: "c.md".to_string(),
            },
            SyncAction::DeleteRemote {
                key: "r.md".to_string(),
            },
            SyncAction::DeleteLocal {
                key: "l.md".to_string(),
            },
        ];

        let (round, deferred) = take_round(&actions, 40);

        assert_eq!(keys(&round), ["l.md", "r.md", "c.md", "d.md", "z.md"]);
        assert!(deferred.is_empty());
    }

    /// Worker は `bucket.delete(keys)` を 1 回呼ぶだけ。本数で割ると、
    /// 使っていない予算のぶんだけ round が無駄に増える。
    #[test]
    fn remote_deletes_cost_one_no_matter_how_many() {
        let mut actions: Vec<SyncAction> = (0..50)
            .map(|i| SyncAction::DeleteRemote {
                key: format!("gone/{i:03}.md"),
            })
            .collect();
        actions.extend((0..50).map(|i| upload(&format!("notes/{i:03}.md"))));

        let (round, deferred) = take_round(&actions, 40);

        assert_eq!(
            round.len(),
            50 + 39,
            "50 件の削除で 1、残り 39 がアップロード"
        );
        assert_eq!(deferred.len(), 11);
    }

    /// ローカル削除はサーバーに何も頼まない。予算に数えると、1 回で済む
    /// 掃除が何 round にも割れる。
    #[test]
    fn local_deletes_cost_nothing_and_always_go() {
        let actions: Vec<SyncAction> = (0..100)
            .map(|i| SyncAction::DeleteLocal {
                key: format!("gone/{i:03}.md"),
            })
            .collect();

        let (round, deferred) = take_round(&actions, 40);

        assert_eq!(round.len(), 100);
        assert!(deferred.is_empty());
    }

    /// 競合は退避の get + put と上書きの put で 3 回。1 と数えると、
    /// 予算どおりに送ったつもりの bulk が 3 倍のサブリクエストを使う。
    #[test]
    fn a_conflict_counts_as_three() {
        let actions: Vec<SyncAction> = (0..20)
            .map(|i| SyncAction::Conflict {
                key: format!("notes/{i:03}.md"),
            })
            .collect();

        let (round, deferred) = take_round(&actions, 40);

        assert_eq!(round.len(), 13, "13 × 3 = 39 で、14 本目は予算を超える");
        assert_eq!(deferred.len(), 7);
    }

    /// 分かれ方が入力の並びで変わると、失敗した同期をやり直したときに
    /// 前回と違う組み合わせが飛ぶ。
    #[test]
    fn the_split_does_not_depend_on_the_input_order() {
        let forward: Vec<SyncAction> = (0..60)
            .map(|i| upload(&format!("notes/{i:03}.md")))
            .collect();
        let backward: Vec<SyncAction> = forward.iter().rev().cloned().collect();

        assert_eq!(take_round(&forward, 40), take_round(&backward, 40));
    }
}
