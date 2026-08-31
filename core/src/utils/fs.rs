use std::fs::{self, DirEntry};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::CoreError;

pub fn ensure_dir(path: &Path) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// 検証済みのファイル名を `dir` 直下の実ファイルパスに解決する。
/// 名前の検証だけではシンボリックリンク越しに `dir` の外へ出られるので、
/// canonicalize した実体が `dir` 配下にあることまで確かめる。
/// セキュリティ境界なので、置き場ごとに写経せずここだけに置く。
pub fn resolve_existing(dir: &Path, filename: &str) -> Result<PathBuf, CoreError> {
    let path = dir.join(filename);
    if !path.exists() {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }

    let canonical_dir = fs::canonicalize(dir)?;
    let canonical_path = fs::canonicalize(&path)?;
    if !canonical_path.starts_with(&canonical_dir) {
        return Err(CoreError::PathTraversal(filename.to_string()));
    }
    Ok(canonical_path)
}

/// 同一プロセス内の一時ファイル名の衝突を避ける通し番号。
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 同じディレクトリに一時ファイルを書いてから rename で置き換える。
/// `fs::write` の直接上書きは、書いている途中でプロセスが落ちると
/// 半分だけ書けたファイルを残す。タイムラインは追記のたびに 1 日ぶんを
/// 丸ごと書き直すので、それはその日の記録全体の破損を意味する。
/// rename は同一ファイルシステム内なら原子的で、読者は旧内容か新内容の
/// どちらかしか見ない。
///
/// 名前が `.sync-tmp-` なのは、クラッシュで残っても同期スキャンの既存の
/// 除外に一致し、`.md` を持たないのでノート一覧にも現れないため。
/// 電源断への fsync までは踏み込まない: 保存のたびの fsync は
/// モバイルの電池と引き換えになる。ここで防ぐのはプロセス死での破損。
pub fn write_atomic<C: AsRef<[u8]>>(path: &Path, contents: C) -> Result<(), CoreError> {
    let dir = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".sync-tmp-{}-{seq}", std::process::id()));

    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        // rename に失敗した一時ファイルを残すと次の書き込みの邪魔はしないが
        // ゴミが積もる。消せなかったところで元のエラーのほうが重要。
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// `e.path()` はディレクトリ名まで含めた `PathBuf` を確保する。拡張子を見るだけなら
/// ファイル名で足りるので、エントリごとの確保をそのぶん小さくできる。
fn is_md(entry: &DirEntry) -> bool {
    Path::new(&entry.file_name())
        .extension()
        .is_some_and(|ext| ext == "md")
}

pub fn list_md_files(dir: &Path) -> Result<Vec<DirEntry>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(is_md)
        .collect();

    // file_name() は毎回 OsString を確保するので、比較のたびに呼ばせない。
    entries.sort_by_cached_key(|e| std::cmp::Reverse(e.file_name()));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn seed(names: &[&str]) -> TempDir {
        let tmp = TempDir::new().unwrap();
        for name in names {
            fs::write(tmp.path().join(name), "x").unwrap();
        }
        tmp
    }

    #[test]
    fn lists_only_md_files_newest_name_first() {
        let tmp = seed(&["a.md", "b.md", "c.txt", "no-extension"]);

        let names: Vec<_> = list_md_files(tmp.path())
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["b.md", "a.md"]);
    }

    /// `.md` はドットファイルであって拡張子ではない。`Path::extension` の判定に
    /// 揃えているので、名前の末尾一致に置き換わっていないことを確かめる。
    #[test]
    fn a_file_named_just_md_is_not_a_note() {
        let tmp = seed(&[".md"]);

        assert!(list_md_files(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn a_missing_directory_is_empty_rather_than_an_error() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("nope");

        assert!(list_md_files(&missing).unwrap().is_empty());
    }

    #[test]
    fn write_atomic_writes_the_contents() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");

        write_atomic(&path, "hello").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn write_atomic_replaces_what_was_there() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write_atomic(&path, "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    }

    /// 一時ファイルが残ると、名前次第でノート一覧や同期対象に化ける。
    #[test]
    fn write_atomic_leaves_no_temp_file_behind() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");

        write_atomic(&path, "hello").unwrap();

        let names: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["note.md"]);
    }

    /// クラッシュで万一残っても、`.md` でないのでノート一覧には現れず、
    /// `.sync-tmp-` なので同期スキャンの既存の除外にも一致する。
    #[test]
    fn write_atomic_temp_names_are_invisible_to_md_listing() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".sync-tmp-999-0"), "orphan").unwrap();
        fs::write(tmp.path().join("real.md"), "x").unwrap();

        let names: Vec<_> = list_md_files(tmp.path())
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["real.md"]);
    }
}
