pub mod client;
pub mod conflict;
pub mod diff;
pub mod scan;
pub mod state;

use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::CoreError;
use client::SyncClient;
use conflict::ConflictResolution;
use diff::SyncAction;
use state::{FileSyncRecord, SyncState};

pub use client::RemoteFile;
pub use diff::SyncAction as Action;
pub use scan::LocalFile;

#[derive(Debug, Clone, Default, Serialize)]
pub struct SyncResult {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_remote: usize,
    pub deleted_local: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

pub struct SyncEngine<C: SyncClient> {
    client: C,
    base_dir: PathBuf,
}

impl<C: SyncClient> SyncEngine<C> {
    pub fn new(client: C, base_dir: PathBuf) -> Self {
        Self { client, base_dir }
    }

    pub async fn sync(&self) -> Result<SyncResult, CoreError> {
        let mut state = SyncState::load(&self.base_dir)?;
        let local_files = scan::scan_local_files(&self.base_dir)?;
        let remote_files = self.client.list_remote().await?;
        let actions = diff::compute(&local_files, &remote_files, &state);

        let mut result = SyncResult::default();

        // Build lookup maps
        let local_map: std::collections::HashMap<&str, &scan::LocalFile> =
            local_files.iter().map(|f| (f.key.as_str(), f)).collect();
        let remote_map: std::collections::HashMap<&str, &client::RemoteFile> =
            remote_files.iter().map(|f| (f.key.as_str(), f)).collect();

        // Execute pull actions first (download, delete-local)
        for action in &actions {
            match action {
                SyncAction::DownloadNew { key } | SyncAction::DownloadModified { key } => {
                    match self.execute_download(key, &mut state).await {
                        Ok(()) => result.downloaded += 1,
                        Err(e) => result.errors.push(format!("download {key}: {e}")),
                    }
                }
                SyncAction::DeleteLocal { key } => {
                    match self.execute_delete_local(key, &mut state) {
                        Ok(()) => result.deleted_local += 1,
                        Err(e) => result.errors.push(format!("delete-local {key}: {e}")),
                    }
                }
                _ => {}
            }
        }

        // Resolve conflicts
        for action in &actions {
            if let SyncAction::Conflict { key } = action {
                let local = local_map.get(key.as_str());
                let remote = remote_map.get(key.as_str());
                if let (Some(local), Some(remote)) = (local, remote) {
                    match self.execute_conflict(key, local, remote, &mut state).await {
                        Ok(()) => result.conflicts += 1,
                        Err(e) => result.errors.push(format!("conflict {key}: {e}")),
                    }
                }
            }
        }

        // Execute push actions (upload, delete-remote)
        for action in &actions {
            match action {
                SyncAction::UploadNew { key } | SyncAction::UploadModified { key } => {
                    if let Some(local) = local_map.get(key.as_str()) {
                        match self.execute_upload(key, local, &mut state).await {
                            Ok(()) => result.uploaded += 1,
                            Err(e) => result.errors.push(format!("upload {key}: {e}")),
                        }
                    }
                }
                SyncAction::DeleteRemote { key } => {
                    match self.execute_delete_remote(key, &mut state).await {
                        Ok(()) => result.deleted_remote += 1,
                        Err(e) => result.errors.push(format!("delete-remote {key}: {e}")),
                    }
                }
                _ => {}
            }
        }

        state.last_sync = Some(Utc::now());
        state.save(&self.base_dir)?;

        Ok(result)
    }

    async fn execute_download(&self, key: &str, state: &mut SyncState) -> Result<(), CoreError> {
        let content = self.client.download(key).await?;
        let path = self.data_path(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, &content)?;

        let metadata = fs::metadata(&path)?;
        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .into();
        let hash = compute_hash(&content);

        state.files.insert(
            key.to_string(),
            FileSyncRecord {
                last_synced_modified: modified,
                content_hash: hash,
            },
        );

        Ok(())
    }

    fn execute_delete_local(&self, key: &str, state: &mut SyncState) -> Result<(), CoreError> {
        let path = self.data_path(key);
        if path.exists() {
            fs::remove_file(&path)?;
        }
        state.files.remove(key);
        Ok(())
    }

    async fn execute_upload(
        &self,
        key: &str,
        local: &scan::LocalFile,
        state: &mut SyncState,
    ) -> Result<(), CoreError> {
        let path = self.data_path(key);
        let content = fs::read(&path)?;
        self.client
            .upload(key, &content, local.last_modified)
            .await?;

        state.files.insert(
            key.to_string(),
            FileSyncRecord {
                last_synced_modified: local.last_modified,
                content_hash: local.content_hash.clone(),
            },
        );

        Ok(())
    }

    async fn execute_delete_remote(
        &self,
        key: &str,
        state: &mut SyncState,
    ) -> Result<(), CoreError> {
        self.client.delete(key).await?;
        state.files.remove(key);
        Ok(())
    }

    async fn execute_conflict(
        &self,
        key: &str,
        local: &scan::LocalFile,
        remote: &client::RemoteFile,
        state: &mut SyncState,
    ) -> Result<(), CoreError> {
        let resolution = conflict::resolve(local.last_modified, remote.last_modified);
        let now = Utc::now();
        let conflict_key = conflict::conflict_filename(key, now);
        let conflict_path = self.data_path(&conflict_key);

        if let Some(parent) = conflict_path.parent() {
            fs::create_dir_all(parent)?;
        }

        match resolution {
            ConflictResolution::KeepLocal => {
                // Save remote as conflict copy, keep local as-is
                let remote_content = self.client.download(key).await?;
                fs::write(&conflict_path, &remote_content)?;

                // Upload local version
                let local_path = self.data_path(key);
                let content = fs::read(&local_path)?;
                self.client
                    .upload(key, &content, local.last_modified)
                    .await?;

                state.files.insert(
                    key.to_string(),
                    FileSyncRecord {
                        last_synced_modified: local.last_modified,
                        content_hash: local.content_hash.clone(),
                    },
                );
            }
            ConflictResolution::KeepRemote => {
                // Save local as conflict copy
                let local_path = self.data_path(key);
                let local_content = fs::read(&local_path)?;
                fs::write(&conflict_path, &local_content)?;

                // Download remote version
                let remote_content = self.client.download(key).await?;
                fs::write(&local_path, &remote_content)?;

                let hash = compute_hash(&remote_content);
                state.files.insert(
                    key.to_string(),
                    FileSyncRecord {
                        last_synced_modified: remote.last_modified,
                        content_hash: hash,
                    },
                );
            }
        }

        Ok(())
    }

    fn data_path(&self, key: &str) -> PathBuf {
        crate::utils::paths::data_dir(&self.base_dir).join(key)
    }
}

fn compute_hash(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct MockClient {
        files: Mutex<HashMap<String, (Vec<u8>, chrono::DateTime<Utc>)>>,
    }

    impl MockClient {
        fn new() -> Self {
            Self {
                files: Mutex::new(HashMap::new()),
            }
        }

        fn with_file(self, key: &str, content: &[u8], modified: chrono::DateTime<Utc>) -> Self {
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (content.to_vec(), modified));
            self
        }
    }

    impl SyncClient for MockClient {
        async fn list_remote(&self) -> Result<Vec<RemoteFile>, CoreError> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .iter()
                .map(|(k, (v, m))| RemoteFile {
                    key: k.clone(),
                    last_modified: *m,
                    size: v.len() as u64,
                })
                .collect())
        }

        async fn download(&self, key: &str) -> Result<Vec<u8>, CoreError> {
            self.files
                .lock()
                .unwrap()
                .get(key)
                .map(|(v, _)| v.clone())
                .ok_or_else(|| CoreError::NotFound(key.to_string()))
        }

        async fn upload(
            &self,
            key: &str,
            content: &[u8],
            modified: chrono::DateTime<Utc>,
        ) -> Result<(), CoreError> {
            self.files
                .lock()
                .unwrap()
                .insert(key.to_string(), (content.to_vec(), modified));
            Ok(())
        }

        async fn delete(&self, key: &str) -> Result<(), CoreError> {
            self.files.lock().unwrap().remove(key);
            Ok(())
        }
    }

    #[tokio::test]
    async fn sync_uploads_new_local_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data").join("notes");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("test.md"), "hello").unwrap();

        let client = MockClient::new();
        let engine = SyncEngine::new(client, dir.path().to_path_buf());
        let result = engine.sync().await.unwrap();

        assert_eq!(result.uploaded, 1);
        assert!(result.errors.is_empty());
    }

    #[tokio::test]
    async fn sync_downloads_new_remote_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("data")).unwrap();

        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 12, 0, 0).unwrap();
        let client = MockClient::new().with_file("notes/remote.md", b"remote content", ts);

        let engine = SyncEngine::new(client, dir.path().to_path_buf());
        let result = engine.sync().await.unwrap();

        assert_eq!(result.downloaded, 1);
        let content = fs::read_to_string(dir.path().join("data/notes/remote.md")).unwrap();
        assert_eq!(content, "remote content");
    }

    #[tokio::test]
    async fn sync_deletes_remote_when_local_deleted() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("data")).unwrap();

        // Pretend this file was synced before
        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 10, 0, 0).unwrap();
        let mut state = SyncState::default();
        state.files.insert(
            "notes/deleted.md".to_string(),
            FileSyncRecord {
                last_synced_modified: ts,
                content_hash: "old_hash".to_string(),
            },
        );
        state.save(dir.path()).unwrap();

        let client = MockClient::new().with_file("notes/deleted.md", b"content", ts);
        let engine = SyncEngine::new(client, dir.path().to_path_buf());
        let result = engine.sync().await.unwrap();

        assert_eq!(result.deleted_remote, 1);
    }

    #[tokio::test]
    async fn sync_creates_conflict_copy() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data").join("notes");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("shared.md"), "local version").unwrap();

        let ts = Utc.with_ymd_and_hms(2026, 4, 22, 14, 0, 0).unwrap();
        let client = MockClient::new().with_file("notes/shared.md", b"remote version", ts);

        // No sync state → both exist → conflict
        let engine = SyncEngine::new(client, dir.path().to_path_buf());
        let result = engine.sync().await.unwrap();

        assert_eq!(result.conflicts, 1);

        // Check that the winner is in place and a conflict copy exists
        let entries: Vec<_> = fs::read_dir(&data)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        // Should have shared.md (winner) and shared.sync-conflict-*.md (loser)
        assert!(entries.iter().any(|n| n == "shared.md"));
        assert!(entries.iter().any(|n| n.contains("sync-conflict")));
    }

    #[tokio::test]
    async fn sync_state_persisted_after_sync() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data").join("notes");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("test.md"), "content").unwrap();

        let client = MockClient::new();
        let engine = SyncEngine::new(client, dir.path().to_path_buf());
        engine.sync().await.unwrap();

        let state = SyncState::load(dir.path()).unwrap();
        assert!(state.last_sync.is_some());
        assert!(state.files.contains_key("notes/test.md"));
    }
}
