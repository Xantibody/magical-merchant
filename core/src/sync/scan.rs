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

/// mtime がこれより新しいファイルはキャッシュに記録しない。
/// mtime の粒度が粗いファイルシステムでは「記録した直後・同じ mtime のまま」の
/// 書き換えにキャッシュが気づけない（git index と同じ racily-clean 問題）。
/// できたてのファイルを対象外にしておけば、その窓は次のスキャンで必ず閉じる。
const RACY_MARGIN: Duration = Duration::from_secs(2);

/// 前回スキャンの結果。mtime と size が一致したファイルはハッシュを使い回し、
/// 読み直しも SHA-256 もしない。同期は書き込みのたびに走るので、全ファイルの
/// 再読込は端末の電池と同期の待ち時間にそのまま乗る。
///
/// キャッシュは正しさに関与しない: 壊れていれば捨てて全件ハッシュし直すだけ。
/// data の外に置くのは、中に置くと自分自身が同期対象になるため。
#[derive(Debug, Default, Serialize, Deserialize)]
struct ScanCache {
    files: HashMap<String, CachedHash>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedHash {
    /// UNIX epoch ミリ秒。文字列の日時より比較が速く、キャッシュも小さい。
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

    /// 書けなくても致命ではない。次のスキャンが全件ハッシュに戻るだけ。
    ///
    /// それでも書き換えは原子的にする。`fs::write` は先に切り詰めるので、
    /// 書いている途中で落ちると半端な JSON が残り、そこから同期が始まると
    /// 全ファイルを読み直す羽目になる。今の書き手はアプリだけだが、
    /// CLI からの同期 (#170) が入れば 2 つになるので、途中の状態を
    /// 他人に見せない意味もある。
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

    // 変化が無ければ書かない。同期は頻繁に走るので、無駄な書き込みも積もる。
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
                // バッファを使い回してファイル 1 件ごとの確保をなくす。
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

/// 同期の道具立てそのものは同期しない。競合コピーはここに出てこない —
/// `data/` の外 (`conflicts/`) に置くので、そもそも走査が届かない。
fn is_excluded(file_name: &str) -> bool {
    file_name == ".sync-state.json"
        // `write_atomic` が rename の直前に置く一時ファイル。クラッシュで残る
        || file_name.starts_with(".sync-tmp-")
}

/// 同期のハッシュはここでしか作らない。engine が削除の直前に計算し直すぶんも
/// 同じ関数を通す — 定義が 2 つに割れると、片方の版が「変更あり」に見え続ける
pub(crate) fn compute_hash(content: &[u8]) -> String {
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

    /// `data/` はあるが中身が無い。無い場合の早期 return とは別の経路で、
    /// 走査そのものが空を返さなければならない。
    #[test]
    fn scan_an_existing_but_empty_data_directory() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("data")).unwrap();

        let files = scan_local_files(dir.path()).unwrap();

        assert!(files.is_empty());
    }

    /// 同期の道具立て(状態ファイルと書きかけの一時ファイル)は、data の中に
    /// あっても同期しない。載ると端末同士が互いの状態を上書きし合う。
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

    // ──────────── ハッシュキャッシュ ────────────

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

    /// mtime を過去に倒し、その値を返す。書きたてのファイルは racily-clean
    /// 対策でキャッシュされないので、テストでは十分に古くしてから測る。
    /// 「同じ mtime」を再現する側は返り値をそのまま使う。`now() - 10s` を
    /// 呼び直すとミリ秒がずれて、別の mtime になってしまう。
    fn age(path: &Path, secs_ago: u64) -> SystemTime {
        let t = SystemTime::now() - Duration::from_secs(secs_ago);
        set_mtime(path, t);
        t
    }

    /// mtime と size が変わっていなければ中身を読み直さない、が仕様。
    /// それを観測するため、中身だけ同サイズで差し替えて mtime を戻す。
    /// 旧ハッシュが返れば読んでいない証拠。
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

    /// git index と同じ racily-clean 対策。書きたてのファイルは mtime の
    /// 粒度内で書き換わってもキャッシュが気づけないので、記録しない。
    #[test]
    fn a_freshly_written_file_is_rehashed_on_every_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_note(dir.path(), "a.md", "hello");
        scan_local_files(dir.path()).unwrap();

        // mtime を保ったまま同サイズで書き換える最悪ケース
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

    /// 落ちても半端な JSON を残さない。置き換えは rename なので、先に開いた
    /// 読み手は最後まで旧内容を読み切れる。`fs::write` は書く前に切り詰めるので、
    /// 同じ読み手が空か途中までの JSON を読むことになる。
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

    /// キャッシュは data の外に置く。data 配下だと自分自身が同期対象になる。
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
