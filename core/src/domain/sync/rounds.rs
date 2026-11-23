//! Cuts out the share that goes into one bulk.
//!
//! The Workers Free plan allows 50 subrequests per invocation, and the Worker that
//! receives a bulk hits R2 once per file. Sending a 529-file import in one bulk makes
//! Cloudflare fail it with `Too many subrequests`, and as long as it hits the limit, no
//! retry ever gets through. So the sender cuts at the budget and leaves the rest for the
//! next round.

use super::diff::SyncAction;

/// The cap on R2 operations in one bulk. Counted the same way as the Worker does:
/// `upload + download + conflict x 3 + (1 if any remote delete)`.
///
/// The ceiling is 48: the Free plan's 50 minus the 2 the Worker always spends per bulk
/// (get and put of the state). The slack of 8 keeps old clients working when the Worker
/// side gains one or two more operations.
///
/// The server does not hand this out. With a constant on both sides, a mismatch stops
/// visibly with the Worker's 413, which is better than breaking silently.
pub const BULK_OPERATION_BUDGET: usize = 40;

/// Splits `actions` into "sent in this round" and "left for the next".
///
/// The order is deletes, then conflicts, then downloads, then uploads. Taking in other
/// devices' edits before pushing our own makes a new conflict less likely between rounds.
/// Within a kind the order is by key, so the same input always splits the same way.
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

/// Those that spend no budget come first. Within one rank the order is by key.
const fn rank(action: &SyncAction) -> u8 {
    match action {
        SyncAction::DeleteLocal { .. } => 0,
        SyncAction::DeleteRemote { .. } => 1,
        SyncAction::Conflict { .. } => 2,
        SyncAction::DownloadNew { .. } | SyncAction::DownloadModified { .. } => 3,
        SyncAction::UploadNew { .. } | SyncAction::UploadModified { .. } => 4,
    }
}

/// How many R2 calls this action makes the Worker spend.
///
/// A local delete asks the server for nothing. Remote deletes, however many, take one
/// `bucket.delete(keys)`, so the second onward costs 0. A conflict costs 3, get + put +
/// put, because the remote side is set aside.
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

    /// This is the Mac right after an import. 529 uploads in one bulk crash the Worker,
    /// so the split must stop at the budget.
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

    /// Other devices' edits come in first, then our own go out. The other way round
    /// produces a round where an upload lands on top of a version not yet taken in.
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

    /// The Worker calls `bucket.delete(keys)` once. Charging per file adds needless
    /// rounds for budget that is never spent.
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

    /// A local delete asks the server for nothing. Counting it against the budget splits
    /// a cleanup that fits in one round across many.
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

    /// A conflict is 3: get + put to set the remote aside, and a put to overwrite. Counted
    /// as 1, a bulk that seems to fit the budget spends three times the subrequests.
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

    /// If the split depended on the input order, retrying a failed sync would send a
    /// different combination than the last time.
    #[test]
    fn the_split_does_not_depend_on_the_input_order() {
        let forward: Vec<SyncAction> = (0..60)
            .map(|i| upload(&format!("notes/{i:03}.md")))
            .collect();
        let backward: Vec<SyncAction> = forward.iter().rev().cloned().collect();

        assert_eq!(take_round(&forward, 40), take_round(&backward, 40));
    }
}
