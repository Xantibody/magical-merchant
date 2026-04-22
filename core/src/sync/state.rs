use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::CoreError;

const STATE_FILENAME: &str = ".sync-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncState {
    pub files: HashMap<String, FileSyncRecord>,
    pub last_sync: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSyncRecord {
    pub last_synced_modified: DateTime<Utc>,
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
        fs::write(&path, content)?;
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

    #[test]
    fn save_and_load_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState::default();
        state.last_sync = Some(Utc::now());
        state.files.insert(
            "notes/test.md".to_string(),
            FileSyncRecord {
                last_synced_modified: Utc::now(),
                content_hash: "abc123".to_string(),
            },
        );

        state.save(dir.path()).unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();

        assert_eq!(loaded.files.len(), 1);
        assert!(loaded.files.contains_key("notes/test.md"));
        assert!(loaded.last_sync.is_some());
    }
}
