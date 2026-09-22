use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read as _;
use std::path::Path;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::CoreError;
use crate::utils::paths;

#[derive(Debug, Clone)]
pub struct LocalFile {
    pub key: String,
    pub last_modified: DateTime<Utc>,
    pub content_hash: String,
}

const CACHE_FILENAME: &str = ".scan-cache.json";

/// A file whose mtime is newer than this is not recorded in the cache.
/// On a filesystem with coarse mtime granularity, the cache cannot notice a rewrite made
/// "right after recording, with the same mtime" (the racily-clean problem of the git index).
/// Leaving freshly made files out means that window always closes on the next scan.
const RACY_MARGIN: Duration = Duration::from_secs(2);

/// The result of the last scan. A file whose mtime and size match reuses its hash, with
/// no re-read and no SHA-256. Sync runs on every write, so re-reading every file goes
/// straight onto the device's battery and the sync's wait time.
///
/// The cache plays no part in correctness: if it is corrupt, it is dropped and everything
/// is hashed again. It lives outside data because inside it would become a sync target itself.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ScanCache {
    files: HashMap<String, CachedHash>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedHash {
    /// Milliseconds since the UNIX epoch. Faster to compare than a datetime string, and
    /// the cache is smaller.
    mtime_ms: i64,
    size: u64,
    hash: String,
}

impl ScanCache {
    fn load(base_dir: &Path) -> Self {
        fs::read_to_string(base_dir.join(CACHE_FILENAME))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// A failed write is not fatal. The next scan just falls back to hashing everything.
    ///
    /// The replacement is still atomic. `fs::write` truncates first, so a crash mid-write
    /// leaves half a JSON, and a sync that starts from it ends up re-reading every file.
    /// There are two writers, the app and the CLI, so it also matters that no one sees
    /// the in-between state.
    fn save(&self, base_dir: &Path) {
        if let Ok(content) = serde_json::to_string(self) {
            let _ = crate::utils::fs::write_atomic(&base_dir.join(CACHE_FILENAME), content);
        }
    }
}

pub fn scan_local_files(base_dir: &Path) -> Result<Vec<LocalFile>, CoreError> {
    let data_dir = paths::data_dir(base_dir);
    if !data_dir.exists() {
        return Ok(Vec::new());
    }

    let cached = ScanCache::load(base_dir);
    let mut walk = Walk {
        files: Vec::new(),
        cached,
        fresh: ScanCache::default(),
        now: SystemTime::now(),
    };
    walk_dir(&data_dir, &data_dir, &mut walk)?;

    // No write when nothing changed. Sync runs often, so needless writes add up.
    if walk.fresh.files != walk.cached.files {
        walk.fresh.save(base_dir);
    }
    Ok(walk.files)
}

struct Walk {
    files: Vec<LocalFile>,
    cached: ScanCache,
    fresh: ScanCache,
    now: SystemTime,
}

fn walk_dir(root: &Path, current: &Path, walk: &mut Walk) -> Result<(), CoreError> {
    let mut content = Vec::new();
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();

        // Use the d_type readdir returns as is. path.is_dir() and path.is_file() each
        // issue a stat, so together with metadata this was 3 calls per entry.
        let file_type = entry.file_type()?;
        let metadata = if file_type.is_symlink() {
            // Following the link target is unchanged. A broken link is left out of the scan.
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            metadata
        } else {
            entry.metadata()?
        };

        if metadata.is_dir() {
            walk_dir(root, &path, walk)?;
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

        let modified_at = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let modified: DateTime<Utc> = modified_at.into();
        let mtime_ms = modified.timestamp_millis();
        let size = metadata.len();

        let hash = match walk.cached.files.get(&key) {
            Some(c) if c.mtime_ms == mtime_ms && c.size == size => c.hash.clone(),
            _ => {
                // Reuse the buffer to avoid one allocation per file.
                content.clear();
                content.reserve(usize::try_from(size).unwrap_or(0));
                File::open(&path)?.read_to_end(&mut content)?;
                compute_hash(&content)
            }
        };

        let old_enough = walk
            .now
            .duration_since(modified_at)
            .is_ok_and(|elapsed| elapsed >= RACY_MARGIN);
        if old_enough {
            walk.fresh.files.insert(
                key.clone(),
                CachedHash {
                    mtime_ms,
                    size,
                    hash: hash.clone(),
                },
            );
        }

        walk.files.push(LocalFile {
            key,
            last_modified: modified,
            content_hash: hash,
        });
    }
    Ok(())
}

/// The sync machinery itself is not synced. Conflict copies do not show up here: they
/// live outside `data/` (in `conflicts/`), so the scan never reaches them.
fn is_excluded(file_name: &str) -> bool {
    file_name == ".sync-state.json"
        // The temp file `write_atomic` puts down just before the rename. A crash leaves it behind
        || file_name.starts_with(".sync-tmp-")
}

/// The sync hash is made only here. What the engine recomputes right before a delete
/// goes through the same function: with two definitions, one version keeps looking "changed"
pub(crate) fn compute_hash(content: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut hasher = Sha256::new();
    hasher.update(content);
    // format!("{:x}") runs 32 bytes through fmt. The output is always 64 characters, so
    // building it directly is faster and takes one allocation.
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

    /// `data/` exists but is empty. This is a different path from the early return when
    /// it is missing; the scan itself has to return empty.
    #[test]
    fn scan_an_existing_but_empty_data_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("data")).unwrap();

        let files = scan_local_files(dir.path()).unwrap();

        assert!(files.is_empty());
    }

    /// The sync machinery (the state file and a half-written temp file) is not synced even
    /// when it sits inside data. If it were, devices would overwrite each other's state.
    #[test]
    fn sync_state_and_temp_files_inside_data_are_not_scanned() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        seed_note(dir.path(), "a.md", "hello");
        fs::write(data.join(".sync-state.json"), "{}").unwrap();
        fs::write(data.join(".sync-tmp-1-0"), "half written").unwrap();

        let files = scan_local_files(dir.path()).unwrap();

        let keys: Vec<&str> = files.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["notes/a.md"]);
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
    fn scan_walks_nested_directories() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let nested = data.join("notes").join("archive").join("2026");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("note.md"), "note content").unwrap();

        let files = scan_local_files(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].key, "notes/archive/2026/note.md");
    }

    #[test]
    fn compute_hash_is_deterministic() {
        let h1 = compute_hash(b"hello world");
        let h2 = compute_hash(b"hello world");
        assert_eq!(h1, h2);
        assert_ne!(h1, compute_hash(b"different"));
    }

    /// The hash is compared against the server's, so a dropped digit or uppercase breaks sync.
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

    // ──────────── hash cache ────────────

    use std::time::Duration;

    fn seed_note(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
        let notes = dir.join("data").join("notes");
        fs::create_dir_all(&notes).unwrap();
        let path = notes.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    fn set_mtime(path: &Path, t: SystemTime) {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    /// Pushes the mtime into the past and returns that value. A freshly written file is
    /// not cached because of the racily-clean guard, so the tests age it enough first.
    /// A test that reproduces "the same mtime" uses the return value as is. Calling
    /// `now() - 10s` again shifts the milliseconds and yields a different mtime.
    fn age(path: &Path, secs_ago: u64) -> SystemTime {
        let t = SystemTime::now() - Duration::from_secs(secs_ago);
        set_mtime(path, t);
        t
    }

    /// The spec: no re-read of the content when mtime and size are unchanged.
    /// To observe it, swap only the content for one of the same size and restore the mtime.
    /// Getting the old hash back proves nothing was read.
    #[test]
    fn an_unchanged_file_is_not_rehashed_on_the_next_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_note(dir.path(), "a.md", "hello");
        let mtime = age(&path, 10);
        let first = scan_local_files(dir.path()).unwrap();

        fs::write(&path, "world").unwrap();
        set_mtime(&path, mtime);
        let second = scan_local_files(dir.path()).unwrap();

        assert_eq!(second[0].content_hash, first[0].content_hash);
        assert_eq!(second[0].content_hash, compute_hash(b"hello"));
    }

    #[test]
    fn a_changed_mtime_invalidates_the_cached_hash() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_note(dir.path(), "a.md", "hello");
        age(&path, 10);
        scan_local_files(dir.path()).unwrap();

        fs::write(&path, "world").unwrap();
        age(&path, 5);
        let second = scan_local_files(dir.path()).unwrap();

        assert_eq!(second[0].content_hash, compute_hash(b"world"));
    }

    #[test]
    fn a_changed_size_invalidates_even_with_the_same_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_note(dir.path(), "a.md", "hello");
        let mtime = age(&path, 10);
        scan_local_files(dir.path()).unwrap();

        fs::write(&path, "hi").unwrap();
        set_mtime(&path, mtime);
        let second = scan_local_files(dir.path()).unwrap();

        assert_eq!(second[0].content_hash, compute_hash(b"hi"));
    }

    /// The same racily-clean guard as the git index. A freshly written file is not
    /// recorded, because the cache cannot notice a rewrite within the mtime granularity.
    #[test]
    fn a_freshly_written_file_is_rehashed_on_every_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_note(dir.path(), "a.md", "hello");
        scan_local_files(dir.path()).unwrap();

        // The worst case: a same-size rewrite that keeps the mtime
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, "world").unwrap();
        set_mtime(&path, mtime);
        let second = scan_local_files(dir.path()).unwrap();

        assert_eq!(second[0].content_hash, compute_hash(b"world"));
    }

    #[test]
    fn a_corrupt_cache_file_is_ignored_and_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        seed_note(dir.path(), "a.md", "hello");
        fs::write(dir.path().join(".scan-cache.json"), "{not json").unwrap();

        let files = scan_local_files(dir.path()).unwrap();

        assert_eq!(files[0].content_hash, compute_hash(b"hello"));
    }

    /// A crash leaves no half JSON. The replacement is a rename, so a reader that opened
    /// the file first reads the old content to the end. `fs::write` truncates before it
    /// writes, so the same reader would get an empty or partial JSON.
    #[test]
    fn the_cache_is_replaced_whole_rather_than_truncated_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CACHE_FILENAME);
        fs::write(&path, "previous cache").unwrap();
        let reader = File::open(&path).unwrap();

        let mut cache = ScanCache::default();
        cache.files.insert(
            "notes/a.md".to_string(),
            CachedHash {
                mtime_ms: 1,
                size: 5,
                hash: "hash-a".to_string(),
            },
        );
        cache.save(dir.path());

        assert_eq!(std::io::read_to_string(reader).unwrap(), "previous cache");
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("\"notes/a.md\"")
        );
    }

    /// The cache lives outside data. Under data it would become a sync target itself.
    #[test]
    fn the_cache_file_never_appears_in_scan_results() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_note(dir.path(), "a.md", "hello");
        age(&path, 10);
        scan_local_files(dir.path()).unwrap();
        let second = scan_local_files(dir.path()).unwrap();

        assert_eq!(second.len(), 1);
        assert_eq!(second[0].key, "notes/a.md");
    }
}
