use std::fs;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::CoreError;

#[derive(Debug, Clone)]
pub struct LocalFile {
    pub key: String,
    pub last_modified: DateTime<Utc>,
    pub content_hash: String,
}

pub fn scan_local_files(base_dir: &Path) -> Result<Vec<LocalFile>, CoreError> {
    let data_dir = base_dir.join("data");
    if !data_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    walk_dir(&data_dir, &data_dir, &mut files)?;
    Ok(files)
}

fn walk_dir(root: &Path, current: &Path, files: &mut Vec<LocalFile>) -> Result<(), CoreError> {
    let entries = fs::read_dir(current)?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();

        if path.is_dir() {
            walk_dir(root, &path, files)?;
        } else if path.is_file() {
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

            if is_excluded(file_name) {
                continue;
            }

            let relative = path
                .strip_prefix(root)
                .map_err(|e| CoreError::Sync(e.to_string()))?;
            let key = relative
                .to_str()
                .ok_or_else(|| CoreError::Sync("non-UTF8 path".to_string()))?
                .to_string();

            let metadata = fs::metadata(&path)?;
            let modified: DateTime<Utc> =
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH).into();

            let content = fs::read(&path)?;
            let hash = compute_hash(&content);

            files.push(LocalFile {
                key,
                last_modified: modified,
                content_hash: hash,
            });
        }
    }
    Ok(())
}

fn is_excluded(file_name: &str) -> bool {
    file_name.contains(".sync-conflict-") || file_name == ".sync-state.json"
}

fn compute_hash(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scan_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        let files = scan_local_files(dir.path()).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn scan_finds_md_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let notes = data.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("test.md"), "hello").unwrap();

        let files = scan_local_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].key, "notes/test.md");
    }

    #[test]
    fn scan_excludes_conflict_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let notes = data.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("test.md"), "hello").unwrap();
        fs::write(
            notes.join("test.sync-conflict-20260422-120000.md"),
            "conflict",
        )
        .unwrap();

        let files = scan_local_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].key, "notes/test.md");
    }

    #[test]
    fn scan_walks_nested_directories() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let active = data.join("projects").join("my-proj").join("active");
        fs::create_dir_all(&active).unwrap();
        fs::write(active.join("task.md"), "task content").unwrap();

        let files = scan_local_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].key, "projects/my-proj/active/task.md");
    }

    #[test]
    fn compute_hash_is_deterministic() {
        let h1 = compute_hash(b"hello world");
        let h2 = compute_hash(b"hello world");
        assert_eq!(h1, h2);
        assert_ne!(h1, compute_hash(b"different"));
    }
}
