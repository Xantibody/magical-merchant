use std::fs::{self, File};
use std::io::Read as _;
use std::path::Path;
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::CoreError;
use crate::utils::paths;

#[derive(Debug, Clone)]
pub struct LocalFile {
    pub key: String,
    pub last_modified: DateTime<Utc>,
    pub content_hash: String,
}

pub fn scan_local_files(base_dir: &Path) -> Result<Vec<LocalFile>, CoreError> {
    let data_dir = paths::data_dir(base_dir);
    if !data_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    walk_dir(&data_dir, &data_dir, &mut files)?;
    Ok(files)
}

fn walk_dir(root: &Path, current: &Path, files: &mut Vec<LocalFile>) -> Result<(), CoreError> {
    let mut content = Vec::new();
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();

        // readdir が返す d_type をそのまま使う。path.is_dir() と path.is_file() は
        // それぞれ stat を発行するので、metadata と合わせて 1 件につき 3 回叩いていた。
        let file_type = entry.file_type()?;
        let metadata = if file_type.is_symlink() {
            // リンク先を見るのは従来どおり。壊れたリンクは走査対象から外す。
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            metadata
        } else {
            entry.metadata()?
        };

        if metadata.is_dir() {
            walk_dir(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }

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

        let modified: DateTime<Utc> = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH).into();

        // バッファを使い回してファイル 1 件ごとの確保をなくす。
        content.clear();
        content.reserve(usize::try_from(metadata.len()).unwrap_or(0));
        File::open(&path)?.read_to_end(&mut content)?;

        files.push(LocalFile {
            key,
            last_modified: modified,
            content_hash: compute_hash(&content),
        });
    }
    Ok(())
}

fn is_excluded(file_name: &str) -> bool {
    file_name.contains(".sync-conflict-")
        || file_name == ".sync-state.json"
        // サーバー駆動同期以前のクライアントがクラッシュ時に残した一時ファイル
        || file_name.starts_with(".sync-tmp-")
}

fn compute_hash(content: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut hasher = Sha256::new();
    hasher.update(content);
    // format!("{:x}") は 32 バイトぶん fmt を通る。出力長は常に 64 文字なので
    // 直接組み立てたほうが速く、確保も 1 回で済む。
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
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

    /// ハッシュはサーバーと突き合わせる値なので、桁落ちや大文字化は同期を壊す。
    #[test]
    fn compute_hash_is_lowercase_zero_padded_hex() {
        assert_eq!(
            compute_hash(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn scan_follows_symlinked_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let notes = data.join("notes");
        fs::create_dir_all(&notes).unwrap();
        fs::write(dir.path().join("outside.md"), "hello").unwrap();
        std::os::unix::fs::symlink(dir.path().join("outside.md"), notes.join("linked.md")).unwrap();

        let files = scan_local_files(dir.path()).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].key, "notes/linked.md");
        assert_eq!(files[0].content_hash, compute_hash(b"hello"));
    }

    #[test]
    fn scan_skips_broken_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("data").join("notes");
        fs::create_dir_all(&notes).unwrap();
        std::os::unix::fs::symlink(dir.path().join("gone.md"), notes.join("dangling.md")).unwrap();

        assert!(scan_local_files(dir.path()).unwrap().is_empty());
    }
}
