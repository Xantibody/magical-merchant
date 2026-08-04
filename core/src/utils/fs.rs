use std::fs::{self, DirEntry};
use std::path::Path;

use crate::error::CoreError;

pub fn ensure_dir(path: &Path) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
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
}
