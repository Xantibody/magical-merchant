use std::fs;
use std::io;
use std::path::PathBuf;

use chrono::{Local, NaiveDate};

use crate::error::CoreError;
use crate::scrawl::day::DayLog;
use crate::utils::device::{Context, Source};
use crate::utils::fs::{ensure_dir, write_atomic};
use crate::utils::markdown::{split_context_json, split_time_prefix};
use crate::utils::paths::{self, scrawl_file_path};

pub(crate) struct Scrawl {
    base_dir: PathBuf,
}

impl Scrawl {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub(crate) fn save_entry(
        &self,
        text: &str,
        context: &Context,
        source: Source,
    ) -> Result<(), CoreError> {
        let now = Local::now();
        let file_path = scrawl_file_path(&self.base_dir, now.date_naive());
        ensure_dir(&file_path)?;

        let mut day = DayLog::parse(&self.read_raw(now.date_naive())?.unwrap_or_default());
        day.push(text, now, context, Some(source));

        write_atomic(&file_path, day.render()?)?;
        Ok(())
    }

    pub(crate) fn list_dates(&self) -> Result<Vec<NaiveDate>, CoreError> {
        let scrawl_dir = paths::data_dir(&self.base_dir).join(paths::SCRAWL_DIR);
        if !scrawl_dir.exists() {
            return Ok(Vec::new());
        }

        let mut dates: Vec<NaiveDate> = fs::read_dir(&scrawl_dir)?
            .filter_map(Result::ok)
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let stem = name.strip_suffix(".md")?;
                NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()
            })
            .collect();

        dates.sort_by(|a, b| b.cmp(a));
        Ok(dates)
    }

    pub(crate) fn read(&self, date: NaiveDate) -> Result<Vec<String>, CoreError> {
        Ok(self
            .read_raw(date)?
            .map(|content| DayLog::parse(&content).expanded())
            .unwrap_or_default())
    }

    /// その日のファイルをそのまま返す。存在しなければ `None`。
    /// 先に `exists()` を挟まないのは、読めるかどうかは開いてみれば分かるからで、
    /// 全日付を舐める検索では stat の 1 回が日数ぶん積み上がる。
    pub(crate) fn read_raw(&self, date: NaiveDate) -> Result<Option<String>, CoreError> {
        match fs::read_to_string(scrawl_file_path(&self.base_dir, date)) {
            Ok(content) => Ok(Some(content)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// `raw` は書き手が読んだときの行。index がその行を指していなければ書かない。
    pub(crate) fn update_entry(
        &self,
        date: NaiveDate,
        index: usize,
        raw: &str,
        text: &str,
    ) -> Result<(), CoreError> {
        self.rewrite(date, |day| {
            expect_same_entry(day, index, raw)?;
            let entry = day
                .entries_mut()
                .get_mut(index)
                .ok_or_else(|| CoreError::NotFound(format!("scrawl entry {index}")))?;
            *entry = replace_entry_text(entry, text);
            Ok(())
        })
    }

    /// `raw` は `update_entry` と同じ、書き手が読んだときの行。
    pub(crate) fn delete_entry(
        &self,
        date: NaiveDate,
        index: usize,
        raw: &str,
    ) -> Result<(), CoreError> {
        self.rewrite(date, |day| {
            // 範囲の確認も `expect_same_entry` が済ませている — 行が無ければ
            // 読んだ行とは一致しようがない
            expect_same_entry(day, index, raw)?;
            day.entries_mut().remove(index);
            Ok(())
        })
    }

    /// 日を読んで `edit` に渡し、空になっていなければ書き戻す。
    /// 渡すのが行の `Vec` ではなく `DayLog` なのは、行だけでは畳まれた端末
    /// 情報を戻せず、読み手が見たのと同じ行を組み立てられないため。
    ///
    /// 読んでから書くまでは不可分ではない。`write_atomic` が原子なのは書き込み
    /// 1 回きりで、`read_raw` → `expect_same_entry` → 書き の間に同じ日へ書かれ
    /// れば、古い `DayLog` を突き合わせて書き戻す — 割り込んだ記録は消える。
    /// 塞ぐにはこの日ファイルへ書く全員が 1 つのロックを取る必要がある:
    /// `save_entry` と、同期の `write_under` / `delete_local_file`。
    // AIDEV-NOTE: 読み→照合→書きは不可分でない。SyncLock 流用は capture が busy で落ちるので見送り、排他は別 PR
    fn rewrite<F>(&self, date: NaiveDate, edit: F) -> Result<(), CoreError>
    where
        F: FnOnce(&mut DayLog) -> Result<(), CoreError>,
    {
        let file_path = scrawl_file_path(&self.base_dir, date);
        let Some(content) = self.read_raw(date)? else {
            return Err(CoreError::NotFound(file_path.to_string_lossy().to_string()));
        };

        let mut day = DayLog::parse(&content);
        edit(&mut day)?;

        if day.is_empty() {
            fs::remove_file(&file_path)?;
            return Ok(());
        }

        write_atomic(&file_path, day.render()?)?;
        Ok(())
    }
}

/// `index` がいま指している行が、書き手の読んだ `raw` と同じかを確かめる。
///
/// 日ファイルは追記で育つので、index は「読んだときの位置」でしかない。同期や
/// ウィジェットがその日の前へ 1 行足せば、同じ index は隣の記録を指す。
///
/// 突き合わせるのは `read` が返した展開後の行。ディスク上の行は端末情報が
/// frontmatter に畳まれていて、書き手はそれを見ていない。
// AIDEV-NOTE: ずれは NotFound ではなく Stale — 出口が「読み直して再試行」で、消えた行とは違う
fn expect_same_entry(day: &DayLog, index: usize, raw: &str) -> Result<(), CoreError> {
    let Some(entry) = day.expanded_at(index) else {
        return Err(CoreError::NotFound(format!("scrawl entry {index}")));
    };
    if entry == raw {
        return Ok(());
    }
    Err(CoreError::Stale(format!("scrawl entry {index}")))
}

/// 本文だけを差し替え、時刻プレフィックスと末尾のコンテキスト JSON は元のまま残す。
/// 記録時の状況は後からの編集で書き換わってはいけない。
fn replace_entry_text(entry: &str, text: &str) -> String {
    let Some((prefix, rest)) = split_time_prefix(entry) else {
        return text.to_string();
    };

    split_context_json(rest).map_or_else(
        || format!("{prefix}{text}"),
        |json| format!("{prefix}{text} {json}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::fs::ensure_dir;
    use tempfile::TempDir;

    const DATE: &str = "2026-08-04";

    fn date() -> NaiveDate {
        NaiveDate::parse_from_str(DATE, "%Y-%m-%d").unwrap()
    }

    fn seed(lines: &[&str]) -> (TempDir, Scrawl) {
        let tmp = TempDir::new().unwrap();
        let path = scrawl_file_path(tmp.path(), date());
        ensure_dir(&path).unwrap();
        fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        let scrawl = Scrawl::new(tmp.path().to_path_buf());
        (tmp, scrawl)
    }

    #[test]
    fn update_entry_replaces_only_the_text() {
        let (_tmp, scrawl) = seed(&[
            "- [09:00:00] first {\"battery\":80}",
            "- [10:00:00] second {\"battery\":70}",
        ]);

        scrawl
            .update_entry(
                date(),
                1,
                "- [10:00:00] second {\"battery\":70}",
                "rewritten",
            )
            .unwrap();

        let entries = scrawl.read(date()).unwrap();
        assert_eq!(entries[0], "- [09:00:00] first {\"battery\":80}");
        assert_eq!(entries[1], "- [10:00:00] rewritten {\"battery\":70}");
    }

    #[test]
    fn update_entry_keeps_entries_without_context() {
        let (_tmp, scrawl) = seed(&["- [09:00:00] plain"]);

        scrawl
            .update_entry(date(), 0, "- [09:00:00] plain", "edited")
            .unwrap();

        assert_eq!(scrawl.read(date()).unwrap(), vec!["- [09:00:00] edited"]);
    }

    #[test]
    fn update_entry_preserves_multiline_text() {
        let (_tmp, scrawl) = seed(&["- [09:00:00] one {\"battery\":80}"]);

        scrawl
            .update_entry(
                date(),
                0,
                "- [09:00:00] one {\"battery\":80}",
                "line1\nline2",
            )
            .unwrap();

        assert_eq!(
            scrawl.read(date()).unwrap(),
            vec!["- [09:00:00] line1\nline2 {\"battery\":80}"]
        );
    }

    #[test]
    fn update_entry_rejects_an_index_past_the_end() {
        let (_tmp, scrawl) = seed(&["- [09:00:00] only"]);

        let result = scrawl.update_entry(date(), 1, "- [09:00:00] only", "nope");

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// 読んでから書くまでに同じ日の前へ 1 行入ると、同じ index は隣の記録を
    /// 指す。読んだ行と違うものを指していたら、書かずに断る。
    #[test]
    fn update_entry_refuses_a_line_it_did_not_read() {
        let (_tmp, scrawl) = seed(&["- [08:00:00] slipped in", "- [09:00:00] the one I read"]);

        let result = scrawl.update_entry(date(), 0, "- [09:00:00] the one I read", "edited");

        assert!(matches!(result, Err(CoreError::Stale(_))));
        assert_eq!(
            scrawl.read(date()).unwrap(),
            vec!["- [08:00:00] slipped in", "- [09:00:00] the one I read"]
        );
    }

    /// 誤削除はやり直しがきかない。指した行が読んだものと違うなら、
    /// ファイルには 1 バイトも触れずに断る。
    #[test]
    fn delete_entry_refuses_a_line_it_did_not_read() {
        let (tmp, scrawl) = seed(&["- [08:00:00] slipped in", "- [09:00:00] the one I read"]);
        let before = fs::read_to_string(scrawl_file_path(tmp.path(), date())).unwrap();

        let result = scrawl.delete_entry(date(), 0, "- [09:00:00] the one I read");

        assert!(matches!(result, Err(CoreError::Stale(_))));
        assert_eq!(
            fs::read_to_string(scrawl_file_path(tmp.path(), date())).unwrap(),
            before
        );
    }

    /// 突き合わせるのは `read` が返した形。ディスク上の行は端末情報が
    /// frontmatter へ畳まれているので、そのまま比べると端末を書いた日の
    /// 削除がすべて断られる。
    #[test]
    fn delete_entry_matches_the_line_the_reader_was_given() {
        let tmp = TempDir::new().unwrap();
        let scrawl = Scrawl::new(tmp.path().to_path_buf());
        let context = Context {
            battery: Some(56),
            os: "macos".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        scrawl.save_entry("first", &context, Source::App).unwrap();
        scrawl.save_entry("second", &context, Source::App).unwrap();

        let today = Local::now().date_naive();
        let raw = scrawl.read(today).unwrap()[1].clone();
        assert!(raw.contains("\"hostname\":\"MacBook\""));

        scrawl.delete_entry(today, 1, &raw).unwrap();

        let entries = scrawl.read(today).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].contains("first"));
    }

    #[test]
    fn delete_entry_removes_just_that_entry() {
        let (_tmp, scrawl) = seed(&[
            "- [09:00:00] first",
            "- [10:00:00] second",
            "- [11:00:00] third",
        ]);

        scrawl
            .delete_entry(date(), 1, "- [10:00:00] second")
            .unwrap();

        assert_eq!(
            scrawl.read(date()).unwrap(),
            vec!["- [09:00:00] first", "- [11:00:00] third"]
        );
    }

    #[test]
    fn delete_entry_removes_the_file_once_the_day_is_empty() {
        let (tmp, scrawl) = seed(&["- [09:00:00] only"]);

        scrawl.delete_entry(date(), 0, "- [09:00:00] only").unwrap();

        assert!(!scrawl_file_path(tmp.path(), date()).exists());
        assert!(scrawl.read(date()).unwrap().is_empty());
    }

    #[test]
    fn delete_entry_rejects_an_index_past_the_end() {
        let (_tmp, scrawl) = seed(&["- [09:00:00] only"]);

        let result = scrawl.delete_entry(date(), 5, "- [09:00:00] only");

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// 実際に保存されていた日（macOS と Android が同居し、行末に完全な
    /// コンテキストが載った旧形式）に追記しても、既存の記録は 1 件も
    /// 意味を変えてはならない。
    #[test]
    fn appending_to_a_legacy_day_leaves_every_old_entry_intact() {
        let legacy = [
            "- [00:21:05] うっざ {\"battery\":56,\"is_charging\":false,\"network_type\":\"WiFi\",\"os\":\"macos\",\"os_version\":\"26.3.1\",\"arch\":\"aarch64\",\"hostname\":\"MacBook\",\"locale\":\"ja_JP\"}",
            "- [09:18:56] ストレス溜まってる {\"location\":{\"latitude\":35.6761403,\"longitude\":139.5465634},\"os\":\"android\",\"arch\":\"aarch64\"}",
        ];
        let (_tmp, scrawl) = seed(&legacy);

        scrawl
            .save_entry(
                "あたらしい",
                &Context {
                    os: "macos".to_string(),
                    arch: "aarch64".to_string(),
                    ..Context::default()
                },
                Source::App,
            )
            .unwrap();

        let today = Local::now().date_naive();
        let entries = scrawl.read(date()).unwrap();
        assert_eq!(entries, legacy);
        // 今日ぶんは別ファイルなので、上の日には増えていない。
        assert_eq!(
            scrawl.read(today).unwrap().len(),
            usize::from(today != date())
        );
    }

    #[test]
    fn editing_a_legacy_entry_keeps_its_recorded_context() {
        let (_tmp, scrawl) =
            seed(&["- [09:00:00] old {\"battery\":80,\"os\":\"macos\",\"arch\":\"aarch64\"}"]);

        scrawl
            .update_entry(
                date(),
                0,
                "- [09:00:00] old {\"battery\":80,\"os\":\"macos\",\"arch\":\"aarch64\"}",
                "edited",
            )
            .unwrap();

        assert_eq!(
            scrawl.read(date()).unwrap(),
            vec!["- [09:00:00] edited {\"battery\":80,\"os\":\"macos\",\"arch\":\"aarch64\"}"]
        );
    }

    /// 編集で書き換わるのは本文だけ。書いたツールの記録は行末 JSON ごと
    /// 残る — `s` は作成時の記録で、「最後に直したツール」ではない。
    #[test]
    fn editing_an_entry_keeps_the_source_that_wrote_it() {
        let (_tmp, scrawl) = seed(&["- [09:00:00] on the phone {\"battery\":80,\"s\":\"widget\"}"]);

        scrawl
            .update_entry(
                date(),
                0,
                "- [09:00:00] on the phone {\"battery\":80,\"s\":\"widget\"}",
                "edited",
            )
            .unwrap();

        assert_eq!(
            scrawl.read(date()).unwrap(),
            vec!["- [09:00:00] edited {\"battery\":80,\"s\":\"widget\"}"]
        );
    }

    #[test]
    fn editing_a_day_that_lists_its_devices_keeps_the_list() {
        let tmp = TempDir::new().unwrap();
        let scrawl = Scrawl::new(tmp.path().to_path_buf());
        let context = Context {
            battery: Some(56),
            os: "macos".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        let path = scrawl_file_path(tmp.path(), Local::now().date_naive());
        ensure_dir(&path).unwrap();
        scrawl.save_entry("first", &context, Source::App).unwrap();
        scrawl.save_entry("second", &context, Source::App).unwrap();

        let today = Local::now().date_naive();
        let raw = scrawl.read(today).unwrap()[0].clone();
        scrawl.update_entry(today, 0, &raw, "rewritten").unwrap();

        let entries = scrawl.read(today).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].contains("rewritten"));
        assert!(entries[0].contains("\"hostname\":\"MacBook\""));
        assert!(entries[1].contains("\"hostname\":\"MacBook\""));
    }

    #[test]
    fn editing_a_missing_day_reports_not_found() {
        let tmp = TempDir::new().unwrap();
        let scrawl = Scrawl::new(tmp.path().to_path_buf());

        assert!(matches!(
            scrawl.delete_entry(date(), 0, "- [09:00:00] gone"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn text_that_looks_like_json_is_not_mistaken_for_context() {
        let (_tmp, scrawl) = seed(&["- [09:00:00] see {not json"]);

        scrawl
            .update_entry(date(), 0, "- [09:00:00] see {not json", "edited")
            .unwrap();

        assert_eq!(scrawl.read(date()).unwrap(), vec!["- [09:00:00] edited"]);
    }
}
