use std::collections::HashSet;

use super::client::RemoteFile;
use super::scan::LocalFile;
use super::state::SyncState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncAction {
    UploadNew { key: String },
    UploadModified { key: String },
    DownloadNew { key: String },
    DownloadModified { key: String },
    DeleteRemote { key: String },
    DeleteLocal { key: String },
    Conflict { key: String },
}

pub fn compute(
    local_files: &[LocalFile],
    remote_files: &[RemoteFile],
    state: &SyncState,
) -> Vec<SyncAction> {
    let mut actions = Vec::new();

    let local_keys: HashSet<&str> = local_files.iter().map(|f| f.key.as_str()).collect();
    let remote_keys: HashSet<&str> = remote_files.iter().map(|f| f.key.as_str()).collect();

    let local_map: std::collections::HashMap<&str, &LocalFile> =
        local_files.iter().map(|f| (f.key.as_str(), f)).collect();
    let remote_map: std::collections::HashMap<&str, &RemoteFile> =
        remote_files.iter().map(|f| (f.key.as_str(), f)).collect();

    // Keys present in either local or remote
    let all_keys: HashSet<&str> = local_keys.union(&remote_keys).copied().collect();

    // Keys that were previously synced but are now missing from both
    // (handled implicitly - if not in local or remote, nothing to do)

    for key in &all_keys {
        let in_local = local_map.get(key);
        let in_remote = remote_map.get(key);
        let in_state = state.files.get(*key);

        match (in_local, in_remote, in_state) {
            // Both exist, previously synced
            (Some(local), Some(remote), Some(record)) => {
                let local_changed = local.content_hash != record.content_hash;
                let remote_changed = remote.last_modified != record.last_synced_modified;

                match (local_changed, remote_changed) {
                    (true, true) => actions.push(SyncAction::Conflict {
                        key: key.to_string(),
                    }),
                    (true, false) => actions.push(SyncAction::UploadModified {
                        key: key.to_string(),
                    }),
                    (false, true) => actions.push(SyncAction::DownloadModified {
                        key: key.to_string(),
                    }),
                    (false, false) => {} // No change
                }
            }

            // Both exist, never synced (first sync with data on both sides)
            (Some(_), Some(_), None) => {
                actions.push(SyncAction::Conflict {
                    key: key.to_string(),
                });
            }

            // Local only, never synced → upload
            (Some(_), None, None) => {
                actions.push(SyncAction::UploadNew {
                    key: key.to_string(),
                });
            }

            // Remote only, never synced → download
            (None, Some(_), None) => {
                actions.push(SyncAction::DownloadNew {
                    key: key.to_string(),
                });
            }

            // Local exists, remote gone, was synced → remote deleted it
            (Some(_), None, Some(_)) => {
                actions.push(SyncAction::DeleteLocal {
                    key: key.to_string(),
                });
            }

            // Remote exists, local gone, was synced → local deleted it
            (None, Some(_), Some(_)) => {
                actions.push(SyncAction::DeleteRemote {
                    key: key.to_string(),
                });
            }

            // Neither exists (shouldn't happen since we iterate all_keys)
            (None, None, _) => {}
        }
    }

    // Sort for deterministic output
    actions.sort_by(|a, b| action_key(a).cmp(action_key(b)));
    actions
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
    use super::super::state::FileSyncRecord;
    use super::*;
    use chrono::{TimeZone, Utc};

    fn local(key: &str, hash: &str) -> LocalFile {
        LocalFile {
            key: key.to_string(),
            last_modified: Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap(),
            content_hash: hash.to_string(),
        }
    }

    fn remote(key: &str, modified: &str) -> RemoteFile {
        RemoteFile {
            key: key.to_string(),
            last_modified: modified.parse().unwrap(),
            size: 100,
        }
    }

    fn record(hash: &str, modified: &str) -> FileSyncRecord {
        FileSyncRecord {
            last_synced_modified: modified.parse().unwrap(),
            content_hash: hash.to_string(),
        }
    }

    #[test]
    fn empty_local_and_remote() {
        let actions = compute(&[], &[], &SyncState::default());
        assert!(actions.is_empty());
    }

    #[test]
    fn local_only_no_state_uploads() {
        let local_files = vec![local("notes/a.md", "hash_a")];
        let actions = compute(&local_files, &[], &SyncState::default());
        assert_eq!(
            actions,
            vec![SyncAction::UploadNew {
                key: "notes/a.md".into()
            }]
        );
    }

    #[test]
    fn remote_only_no_state_downloads() {
        let remote_files = vec![remote("notes/b.md", "2026-04-22T10:00:00Z")];
        let actions = compute(&[], &remote_files, &SyncState::default());
        assert_eq!(
            actions,
            vec![SyncAction::DownloadNew {
                key: "notes/b.md".into()
            }]
        );
    }

    #[test]
    fn both_exist_no_state_conflict() {
        let local_files = vec![local("notes/c.md", "hash_c")];
        let remote_files = vec![remote("notes/c.md", "2026-04-22T10:00:00Z")];
        let actions = compute(&local_files, &remote_files, &SyncState::default());
        assert_eq!(
            actions,
            vec![SyncAction::Conflict {
                key: "notes/c.md".into()
            }]
        );
    }

    #[test]
    fn both_unchanged_no_action() {
        let local_files = vec![local("notes/d.md", "hash_d")];
        let remote_files = vec![remote("notes/d.md", "2026-04-22T10:00:00Z")];
        let mut state = SyncState::default();
        state.files.insert(
            "notes/d.md".to_string(),
            record("hash_d", "2026-04-22T10:00:00Z"),
        );
        let actions = compute(&local_files, &remote_files, &state);
        assert!(actions.is_empty());
    }

    #[test]
    fn local_modified_uploads() {
        let local_files = vec![local("notes/e.md", "new_hash")];
        let remote_files = vec![remote("notes/e.md", "2026-04-22T10:00:00Z")];
        let mut state = SyncState::default();
        state.files.insert(
            "notes/e.md".to_string(),
            record("old_hash", "2026-04-22T10:00:00Z"),
        );
        let actions = compute(&local_files, &remote_files, &state);
        assert_eq!(
            actions,
            vec![SyncAction::UploadModified {
                key: "notes/e.md".into()
            }]
        );
    }

    #[test]
    fn remote_modified_downloads() {
        let local_files = vec![local("notes/f.md", "hash_f")];
        let remote_files = vec![remote("notes/f.md", "2026-04-22T14:00:00Z")];
        let mut state = SyncState::default();
        state.files.insert(
            "notes/f.md".to_string(),
            record("hash_f", "2026-04-22T10:00:00Z"),
        );
        let actions = compute(&local_files, &remote_files, &state);
        assert_eq!(
            actions,
            vec![SyncAction::DownloadModified {
                key: "notes/f.md".into()
            }]
        );
    }

    #[test]
    fn both_modified_conflict() {
        let local_files = vec![local("notes/g.md", "new_hash")];
        let remote_files = vec![remote("notes/g.md", "2026-04-22T14:00:00Z")];
        let mut state = SyncState::default();
        state.files.insert(
            "notes/g.md".to_string(),
            record("old_hash", "2026-04-22T10:00:00Z"),
        );
        let actions = compute(&local_files, &remote_files, &state);
        assert_eq!(
            actions,
            vec![SyncAction::Conflict {
                key: "notes/g.md".into()
            }]
        );
    }

    #[test]
    fn local_deleted_deletes_remote() {
        let remote_files = vec![remote("notes/h.md", "2026-04-22T10:00:00Z")];
        let mut state = SyncState::default();
        state.files.insert(
            "notes/h.md".to_string(),
            record("hash_h", "2026-04-22T10:00:00Z"),
        );
        let actions = compute(&[], &remote_files, &state);
        assert_eq!(
            actions,
            vec![SyncAction::DeleteRemote {
                key: "notes/h.md".into()
            }]
        );
    }

    #[test]
    fn remote_deleted_deletes_local() {
        let local_files = vec![local("notes/i.md", "hash_i")];
        let mut state = SyncState::default();
        state.files.insert(
            "notes/i.md".to_string(),
            record("hash_i", "2026-04-22T10:00:00Z"),
        );
        let actions = compute(&local_files, &[], &state);
        assert_eq!(
            actions,
            vec![SyncAction::DeleteLocal {
                key: "notes/i.md".into()
            }]
        );
    }

    #[test]
    fn multiple_actions_sorted_by_key() {
        let local_files = vec![local("notes/z.md", "hash_z"), local("notes/a.md", "hash_a")];
        let actions = compute(&local_files, &[], &SyncState::default());
        assert_eq!(actions.len(), 2);
        assert_eq!(
            actions[0],
            SyncAction::UploadNew {
                key: "notes/a.md".into()
            }
        );
        assert_eq!(
            actions[1],
            SyncAction::UploadNew {
                key: "notes/z.md".into()
            }
        );
    }
}
