use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::CoreError;
use crate::utils::clock::UtcStamp;
use crate::utils::fs::write_atomic;

const STATE_FILENAME: &str = ".sync-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncState {
    pub files: HashMap<String, FileSyncRecord>,
    pub last_sync: Option<UtcStamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSyncRecord {
    pub last_synced_modified: UtcStamp,
    pub content_hash: String,
}

impl SyncState {
    pub fn load(base_dir: &Path) -> Result<Self, CoreError> {
        let path = base_dir.join(STATE_FILENAME);
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = fs::read_to_string(&path)?;
        serde_json::from_str(&content).map_err(|e| CoreError::Parse(e.to_string()))
    }

    pub fn save(&self, base_dir: &Path) -> Result<(), CoreError> {
        let path = base_dir.join(STATE_FILENAME);
        let content =
            serde_json::to_string_pretty(self).map_err(|e| CoreError::Sync(e.to_string()))?;
        write_atomic(&path, content)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_returns_default_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let state = SyncState::load(dir.path()).unwrap();
        assert!(state.files.is_empty());
        assert!(state.last_sync.is_none());
    }

    /// A written value comes back as it was. Times keep their sub-second digits: if they
    /// round here, the next sync wrongly decides "local is newer" and transfers again.
    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let last_sync = UtcStamp::now();
        let last_synced_modified = UtcStamp::now().plus_seconds(-30);
        let mut state = SyncState {
            last_sync: Some(last_sync),
            ..SyncState::default()
        };
        state.files.insert(
            "notes/test.md".to_string(),
            FileSyncRecord {
                last_synced_modified,
                content_hash: "abc123".to_string(),
            },
        );

        state.save(dir.path()).unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();

        assert_eq!(loaded.files.len(), 1);
        let record = &loaded.files["notes/test.md"];
        assert_eq!(record.last_synced_modified, last_synced_modified);
        assert_eq!(record.content_hash, "abc123");
        assert_eq!(loaded.last_sync, Some(last_sync));
    }

    /// The round trip above would pass if the spelling changed; this pins the bytes. A
    /// zero offset is `Z` here (unlike the `+00:00` uploaded to the Worker), and the
    /// fraction keeps 3, 6 or 9 digits as needed, never trimmed.
    #[test]
    fn the_state_file_spells_times_as_z_with_autosi_digits() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState {
            last_sync: Some("2026-08-05T00:00:00.120Z".parse().unwrap()),
            ..SyncState::default()
        };
        for (key, at) in [
            ("whole", "2026-08-05T00:00:00Z"),
            ("micro", "2026-08-05T00:00:00.123400Z"),
            ("nano", "2026-08-05T00:00:00.544569369Z"),
            ("tenth", "2026-08-05T00:00:00.100000000Z"),
            ("tokyo", "2026-08-05T09:00:00+09:00"),
        ] {
            state.files.insert(
                key.to_string(),
                FileSyncRecord {
                    last_synced_modified: at.parse().unwrap(),
                    content_hash: "h".to_string(),
                },
            );
        }

        state.save(dir.path()).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join(STATE_FILENAME)).unwrap())
                .unwrap();

        let spelled: Vec<&str> = ["whole", "micro", "nano", "tenth", "tokyo"]
            .iter()
            .map(|key| {
                saved["files"][key]["last_synced_modified"]
                    .as_str()
                    .unwrap()
            })
            .chain([saved["last_sync"].as_str().unwrap()])
            .collect();
        assert_eq!(
            spelled,
            vec![
                "2026-08-05T00:00:00Z",
                "2026-08-05T00:00:00.123400Z",
                "2026-08-05T00:00:00.544569369Z",
                "2026-08-05T00:00:00.100Z",
                "2026-08-05T00:00:00Z",
                "2026-08-05T00:00:00.120Z",
            ]
        );
    }

    /// A state file written by an older build (or by hand) still loads, to the exact
    /// instant: a lost digit would make the next sync see a change that is not there.
    #[test]
    fn old_spellings_of_a_time_still_load() {
        let dir = tempfile::tempdir().unwrap();
        let spellings = [
            "2026-08-05T00:00:00+00:00",
            "2026-08-05T00:00:00.123456789Z",
            "2026-08-05T00:00:00.931Z",
            "2026-08-05T00:00:00.123400+00:00",
            "2026-08-05T09:00:00.5+09:00",
        ];
        let files: serde_json::Map<String, serde_json::Value> = spellings
            .iter()
            .enumerate()
            .map(|(i, at)| {
                (
                    i.to_string(),
                    serde_json::json!({ "last_synced_modified": at, "content_hash": "h" }),
                )
            })
            .collect();
        fs::write(
            dir.path().join(STATE_FILENAME),
            serde_json::json!({ "files": files, "last_sync": "2026-08-05T00:00:00.931Z" })
                .to_string(),
        )
        .unwrap();

        let loaded = SyncState::load(dir.path()).unwrap();

        let read: Vec<String> = (0..spellings.len())
            .map(|i| {
                let at = loaded.files[&i.to_string()].last_synced_modified;
                format!("{} {}", at.unix_seconds(), at.subsec_nanos())
            })
            .collect();
        // Seconds since the epoch and the nanoseconds past them: 2026-08-05T00:00:00Z
        assert_eq!(
            read,
            vec![
                "1785888000 0",
                "1785888000 123456789",
                "1785888000 931000000",
                "1785888000 123400000",
                "1785888000 500000000",
            ]
        );
        let last_sync = loaded.last_sync.unwrap();
        assert_eq!(
            (last_sync.unix_seconds(), last_sync.subsec_nanos()),
            (1_785_888_000, 931_000_000)
        );
    }
}
