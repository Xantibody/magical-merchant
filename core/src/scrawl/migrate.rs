//! `data/timeline/` を `data/scrawl/` へ移す、一度きりの繕い。
//!
//! 面の名は Scrawl なのに、置き場だけが改名前の `timeline` で残っていた。
//! ディスクの名前はそのまま同期キーなので、ここを動かすと他の端末からは
//! 「`timeline/*` が消えて `scrawl/*` が生えた」と映る — 差分は `UploadNew` と
//! `DeleteRemote` になり、1 回の同期で移り切る(`sync/diff.rs`)。
//!
//! 走査より前に呼ぶこと。同期のロックの内側(`sync/engine.rs` の `repair_tree`)、
//! アプリの起動時、CLI の起動時、ウィジェットの JNI —— 日ファイルを書ける
//! 入り口すべてが通る。あとから呼ぶと、改名の途中のツリーを走査に見られる。

use std::fs;
use std::path::Path;

use crate::error::CoreError;
use crate::utils::paths::{SCRAWL_DIR, data_dir};

/// 改名前の置き場。この綴りが残っているのはここだけで、移行が済めば誰も読まない。
const LEGACY_DIR: &str = "timeline";

/// 移した結果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScrawlDirMigration {
    /// 新しい置き場へ移したファイルの数。
    pub moved: usize,
    /// 同じ名前が移動先に既にあったので、旧い置き場に残したファイル。
    ///
    /// 日ファイルは追記で育つので、機械的に混ぜると片方の記録が消える。
    /// 残しておけば同期には `timeline/` のまま乗り続けるが、人が中身を見て
    /// 決められる。
    pub left_behind: Vec<String>,
}

impl ScrawlDirMigration {
    /// 何も動かさなかったか。移行済み、または一度も書いていない端末。
    #[must_use]
    pub const fn is_noop(&self) -> bool {
        self.moved == 0 && self.left_behind.is_empty()
    }
}

/// `data/timeline/` があれば `data/scrawl/` へ移す。何度呼んでもよい。
///
/// 移動先がまだ無ければディレクトリごと `rename` する — 1 回のシステムコール
/// で済み、途中で落ちても「旧いほうが丸ごと残っている」か「新しいほうが
/// 丸ごとある」かのどちらかにしかならない。
///
/// 移動先が既にある(新しい版のアプリが先に書いた)ときだけ 1 ファイルずつ
/// 運ぶ。名前がぶつかったものは上書きも連番退避もせず、旧い置き場に残す。
///
/// # Errors
///
/// 旧い置き場を読めない、または移せないとき。呼び出し側は握りつぶしてよい —
/// 次の起動でまた試すだけで、失ったものは何もない。
pub fn migrate_scrawl_dir(base_dir: &Path) -> Result<ScrawlDirMigration, CoreError> {
    let legacy = data_dir(base_dir).join(LEGACY_DIR);
    if !legacy.is_dir() {
        return Ok(ScrawlDirMigration::default());
    }
    let target = data_dir(base_dir).join(SCRAWL_DIR);

    if !target.exists() {
        let moved = fs::read_dir(&legacy)?.count();
        fs::rename(&legacy, &target)?;
        return Ok(ScrawlDirMigration {
            moved,
            left_behind: Vec::new(),
        });
    }

    let mut result = ScrawlDirMigration::default();
    for entry in fs::read_dir(&legacy)? {
        let entry = entry?;
        let name = entry.file_name();
        let landing = target.join(&name);
        if landing.exists() {
            result.left_behind.push(name.to_string_lossy().into_owned());
            continue;
        }
        fs::rename(entry.path(), &landing)?;
        result.moved += 1;
    }
    // 空になった旧い置き場は消す。残すと、次の同期がディレクトリだけを
    // 見て「まだ移っていない」と読む道はないが、人の目には移行が済んで
    // いないように見える
    if result.left_behind.is_empty() {
        let _ = fs::remove_dir(&legacy);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    fn legacy_day(base: &Path, date: &str, body: &str) {
        write(
            &data_dir(base).join(LEGACY_DIR).join(format!("{date}.md")),
            body,
        );
    }

    fn scrawl_day(base: &Path, date: &str, body: &str) {
        write(
            &data_dir(base).join(SCRAWL_DIR).join(format!("{date}.md")),
            body,
        );
    }

    fn read_scrawl_day(base: &Path, date: &str) -> String {
        fs::read_to_string(data_dir(base).join(SCRAWL_DIR).join(format!("{date}.md"))).unwrap()
    }

    #[test]
    fn a_tree_written_before_the_rename_moves_whole() {
        let tmp = TempDir::new().unwrap();
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 朝");
        legacy_day(tmp.path(), "2026-03-21", "- [09:00:00] 翌日");

        let done = migrate_scrawl_dir(tmp.path()).unwrap();

        assert_eq!(done.moved, 2);
        assert!(done.left_behind.is_empty());
        assert_eq!(read_scrawl_day(tmp.path(), "2026-03-20"), "- [09:00:00] 朝");
        assert!(!data_dir(tmp.path()).join(LEGACY_DIR).exists());
    }

    /// 起動のたびに呼ぶので、2 回目が何も壊さないことが前提になる。
    #[test]
    fn running_it_again_changes_nothing() {
        let tmp = TempDir::new().unwrap();
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 朝");

        migrate_scrawl_dir(tmp.path()).unwrap();
        let again = migrate_scrawl_dir(tmp.path()).unwrap();

        assert!(again.is_noop());
        assert_eq!(read_scrawl_day(tmp.path(), "2026-03-20"), "- [09:00:00] 朝");
    }

    /// 一度も書いていない端末には旧い置き場が無い。
    #[test]
    fn a_tree_without_the_old_directory_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        scrawl_day(tmp.path(), "2026-03-20", "- [09:00:00] 朝");

        assert!(migrate_scrawl_dir(tmp.path()).unwrap().is_noop());
        assert_eq!(read_scrawl_day(tmp.path(), "2026-03-20"), "- [09:00:00] 朝");
    }

    /// 新しい版が先に書いていれば、移動先は既にある。ぶつからない日は運ぶ。
    #[test]
    fn days_that_do_not_collide_move_into_an_existing_directory() {
        let tmp = TempDir::new().unwrap();
        scrawl_day(tmp.path(), "2026-03-21", "- [10:00:00] 新しい版が書いた");
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 古い版が書いた");

        let done = migrate_scrawl_dir(tmp.path()).unwrap();

        assert_eq!(done.moved, 1);
        assert!(done.left_behind.is_empty());
        assert_eq!(
            read_scrawl_day(tmp.path(), "2026-03-20"),
            "- [09:00:00] 古い版が書いた"
        );
        assert_eq!(
            read_scrawl_day(tmp.path(), "2026-03-21"),
            "- [10:00:00] 新しい版が書いた"
        );
    }

    /// 同じ日が両方にあるとき。日ファイルは追記で育つので、混ぜると片方の
    /// 記録が消える。どちらも残して人に決めさせる。
    #[test]
    fn a_day_that_exists_in_both_is_left_where_it_is() {
        let tmp = TempDir::new().unwrap();
        scrawl_day(tmp.path(), "2026-03-20", "- [10:00:00] 新しい置き場");
        legacy_day(tmp.path(), "2026-03-20", "- [09:00:00] 旧い置き場");

        let done = migrate_scrawl_dir(tmp.path()).unwrap();

        assert_eq!(done.moved, 0);
        assert_eq!(done.left_behind, vec!["2026-03-20.md".to_string()]);
        assert_eq!(
            read_scrawl_day(tmp.path(), "2026-03-20"),
            "- [10:00:00] 新しい置き場"
        );
        assert_eq!(
            fs::read_to_string(data_dir(tmp.path()).join(LEGACY_DIR).join("2026-03-20.md"))
                .unwrap(),
            "- [09:00:00] 旧い置き場"
        );
    }
}
