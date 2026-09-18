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

/// 枝番を諦める上限。控えが同じ秒に 100 本並ぶことはないので、ここに当たるのは
/// バグのとき。数え続けて固まるより、その 1 件を運ばず次の起動へ回す。
const MAX_SPARE_NAMES: u32 = 100;

/// `from` を `to` へ移す。`to` が塞がっていたら `-2`, `-3` … と枝番を足した
/// 隣へ置き、実際に置いた場所を返す。
///
/// `write_atomic` とは逆で、既にあるものを消さないことがこの関数の仕事。
/// 控えの名前は秒までしか持たないので、同じ秒に 2 回退避すると同じ名前を
/// 指す。`fs::rename` は Unix では宛先を黙って消すため、素直に呼ぶと先に
/// 取った控えが失われる — 控えは失った編集を取り戻すためだけのものなので、
/// 消える控えは置かないのと同じ。
///
/// AIDEV-NOTE: 空き確認は `create_new`(`O_EXCL`)で。`exists()` → `rename` は見てから移すまでの隙に負ける
pub fn rename_without_clobber(from: &Path, to: &Path) -> Result<PathBuf, CoreError> {
    for n in 1..=MAX_SPARE_NAMES {
        let candidate = if n == 1 {
            to.to_path_buf()
        } else {
            spare_name(to, n)
        };
        let reserved = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(e.into()),
        };
        if reserved {
            // 名前は押さえた。中身を入れるのは自分が作った空ファイルの
            // 上への rename なので、ここで消えるのは自分の目印だけ
            return fs::rename(from, &candidate)
                .map(|()| candidate.clone())
                .inspect_err(|_| {
                    let _ = fs::remove_file(&candidate);
                })
                .map_err(CoreError::from);
        }
    }
    Err(CoreError::Io(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("{} and its spare names are all taken", to.display()),
    )))
}

/// `a/b.md` の 2 番目 → `a/b-2.md`。拡張子は残す — 控えも `.md` のまま
/// 読めないと、戻すときに開けない。
fn spare_name(path: &Path, n: u32) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("conflict");
    let name = path
        .extension()
        .and_then(|e| e.to_str())
        .map_or_else(|| format!("{stem}-{n}"), |ext| format!("{stem}-{n}.{ext}"));
    path.with_file_name(name)
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

    #[test]
    fn rename_without_clobber_moves_to_a_free_name() {
        let tmp = TempDir::new().unwrap();
        let from = tmp.path().join("a.md");
        let to = tmp.path().join("b.md");
        fs::write(&from, "body").unwrap();

        assert_eq!(rename_without_clobber(&from, &to).unwrap(), to);

        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).unwrap(), "body");
    }

    /// 宛先が塞がっていても消さない。控えは失った編集を取り戻すためのもので、
    /// 上書きされる控えは置かないのと同じ。
    #[test]
    fn rename_without_clobber_keeps_what_is_already_there() {
        let tmp = TempDir::new().unwrap();
        let from = tmp.path().join("a.md");
        let to = tmp.path().join("b.md");
        fs::write(&from, "newcomer").unwrap();
        fs::write(&to, "the one already there").unwrap();

        let landed = rename_without_clobber(&from, &to).unwrap();

        assert_eq!(landed, tmp.path().join("b-2.md"));
        assert_eq!(fs::read_to_string(&to).unwrap(), "the one already there");
        assert_eq!(fs::read_to_string(&landed).unwrap(), "newcomer");
    }

    /// 枝番は空くまで進む。拡張子は落とさない — `.md` でないと戻すとき読めない。
    #[test]
    fn rename_without_clobber_counts_up_until_a_name_is_free() {
        let tmp = TempDir::new().unwrap();
        let to = tmp.path().join("b.md");
        fs::write(&to, "first").unwrap();
        fs::write(tmp.path().join("b-2.md"), "second").unwrap();
        let from = tmp.path().join("a.md");
        fs::write(&from, "third").unwrap();

        let landed = rename_without_clobber(&from, &to).unwrap();

        assert_eq!(landed, tmp.path().join("b-3.md"));
        assert_eq!(fs::read_to_string(&landed).unwrap(), "third");
    }

    /// 元が無ければ何も置いていかない。押さえた名前を空ファイルのまま
    /// 残すと、次の控えが「塞がっている」と読んで枝番へ逃げ続ける。
    #[test]
    fn rename_without_clobber_leaves_no_placeholder_when_the_move_fails() {
        let tmp = TempDir::new().unwrap();
        let to = tmp.path().join("b.md");

        assert!(rename_without_clobber(&tmp.path().join("nope.md"), &to).is_err());

        assert!(!to.exists());
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
