use std::fs;
use std::io;
use std::path::PathBuf;

use chrono::{Local, NaiveDate};

use crate::error::CoreError;
use crate::timeline::day::DayLog;
use crate::utils::device::Context;
use crate::utils::fs::ensure_dir;
use crate::utils::markdown::{split_context_json, split_time_prefix};
use crate::utils::paths::{self, timeline_file_path};

pub(crate) struct Timeline {
    base_dir: PathBuf,
}

impl Timeline {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub(crate) fn save_entry(&self, text: &str, context: &Context) -> Result<(), CoreError> {
        let now = Local::now();
        let file_path = timeline_file_path(&self.base_dir, now.date_naive());
        ensure_dir(&file_path)?;

        let mut day = DayLog::parse(&self.read_raw(now.date_naive())?.unwrap_or_default());
        day.push(text, now, context);

        fs::write(&file_path, day.render()?)?;
        Ok(())
    }

    pub(crate) fn list_dates(&self) -> Result<Vec<NaiveDate>, CoreError> {
        let timeline_dir = paths::data_dir(&self.base_dir).join(paths::TIMELINE_DIR);
        if !timeline_dir.exists() {
            return Ok(Vec::new());
        }

        let mut dates: Vec<NaiveDate> = fs::read_dir(&timeline_dir)?
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
        match fs::read_to_string(timeline_file_path(&self.base_dir, date)) {
            Ok(content) => Ok(Some(content)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub(crate) fn update_entry(
        &self,
        date: NaiveDate,
        index: usize,
        text: &str,
    ) -> Result<(), CoreError> {
        self.rewrite(date, |entries| {
            let entry = entries
                .get_mut(index)
                .ok_or_else(|| CoreError::NotFound(format!("timeline entry {index}")))?;
            *entry = replace_entry_text(entry, text);
            Ok(())
        })
    }

    pub(crate) fn delete_entry(&self, date: NaiveDate, index: usize) -> Result<(), CoreError> {
        self.rewrite(date, |entries| {
            if index >= entries.len() {
                return Err(CoreError::NotFound(format!("timeline entry {index}")));
            }
            entries.remove(index);
            Ok(())
        })
    }

    fn rewrite<F>(&self, date: NaiveDate, edit: F) -> Result<(), CoreError>
    where
        F: FnOnce(&mut Vec<String>) -> Result<(), CoreError>,
    {
        let file_path = timeline_file_path(&self.base_dir, date);
        let Some(content) = self.read_raw(date)? else {
            return Err(CoreError::NotFound(file_path.to_string_lossy().to_string()));
        };

        let mut day = DayLog::parse(&content);
        edit(day.entries_mut())?;

        if day.is_empty() {
            fs::remove_file(&file_path)?;
            return Ok(());
        }

        fs::write(&file_path, day.render()?)?;
        Ok(())
    }
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

    fn seed(lines: &[&str]) -> (TempDir, Timeline) {
        let tmp = TempDir::new().unwrap();
        let path = timeline_file_path(tmp.path(), date());
        ensure_dir(&path).unwrap();
        fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        let timeline = Timeline::new(tmp.path().to_path_buf());
        (tmp, timeline)
    }

    #[test]
    fn update_entry_replaces_only_the_text() {
        let (_tmp, timeline) = seed(&[
            "- [09:00:00] first {\"battery\":80}",
            "- [10:00:00] second {\"battery\":70}",
        ]);

        timeline.update_entry(date(), 1, "rewritten").unwrap();

        let entries = timeline.read(date()).unwrap();
        assert_eq!(entries[0], "- [09:00:00] first {\"battery\":80}");
        assert_eq!(entries[1], "- [10:00:00] rewritten {\"battery\":70}");
    }

    #[test]
    fn update_entry_keeps_entries_without_context() {
        let (_tmp, timeline) = seed(&["- [09:00:00] plain"]);

        timeline.update_entry(date(), 0, "edited").unwrap();

        assert_eq!(timeline.read(date()).unwrap(), vec!["- [09:00:00] edited"]);
    }

    #[test]
    fn update_entry_preserves_multiline_text() {
        let (_tmp, timeline) = seed(&["- [09:00:00] one {\"battery\":80}"]);

        timeline.update_entry(date(), 0, "line1\nline2").unwrap();

        assert_eq!(
            timeline.read(date()).unwrap(),
            vec!["- [09:00:00] line1\nline2 {\"battery\":80}"]
        );
    }

    #[test]
    fn update_entry_rejects_an_index_past_the_end() {
        let (_tmp, timeline) = seed(&["- [09:00:00] only"]);

        let result = timeline.update_entry(date(), 1, "nope");

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn delete_entry_removes_just_that_entry() {
        let (_tmp, timeline) = seed(&[
            "- [09:00:00] first",
            "- [10:00:00] second",
            "- [11:00:00] third",
        ]);

        timeline.delete_entry(date(), 1).unwrap();

        assert_eq!(
            timeline.read(date()).unwrap(),
            vec!["- [09:00:00] first", "- [11:00:00] third"]
        );
    }

    #[test]
    fn delete_entry_removes_the_file_once_the_day_is_empty() {
        let (tmp, timeline) = seed(&["- [09:00:00] only"]);

        timeline.delete_entry(date(), 0).unwrap();

        assert!(!timeline_file_path(tmp.path(), date()).exists());
        assert!(timeline.read(date()).unwrap().is_empty());
    }

    #[test]
    fn delete_entry_rejects_an_index_past_the_end() {
        let (_tmp, timeline) = seed(&["- [09:00:00] only"]);

        let result = timeline.delete_entry(date(), 5);

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
        let (_tmp, timeline) = seed(&legacy);

        timeline
            .save_entry(
                "あたらしい",
                &Context {
                    os: "macos".to_string(),
                    arch: "aarch64".to_string(),
                    ..Context::default()
                },
            )
            .unwrap();

        let today = Local::now().date_naive();
        let entries = timeline.read(date()).unwrap();
        assert_eq!(entries, legacy);
        // 今日ぶんは別ファイルなので、上の日には増えていない。
        assert_eq!(
            timeline.read(today).unwrap().len(),
            usize::from(today != date())
        );
    }

    #[test]
    fn editing_a_legacy_entry_keeps_its_recorded_context() {
        let (_tmp, timeline) =
            seed(&["- [09:00:00] old {\"battery\":80,\"os\":\"macos\",\"arch\":\"aarch64\"}"]);

        timeline.update_entry(date(), 0, "edited").unwrap();

        assert_eq!(
            timeline.read(date()).unwrap(),
            vec!["- [09:00:00] edited {\"battery\":80,\"os\":\"macos\",\"arch\":\"aarch64\"}"]
        );
    }

    #[test]
    fn editing_a_day_that_lists_its_devices_keeps_the_list() {
        let tmp = TempDir::new().unwrap();
        let timeline = Timeline::new(tmp.path().to_path_buf());
        let context = Context {
            battery: Some(56),
            os: "macos".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        let path = timeline_file_path(tmp.path(), Local::now().date_naive());
        ensure_dir(&path).unwrap();
        timeline.save_entry("first", &context).unwrap();
        timeline.save_entry("second", &context).unwrap();

        let today = Local::now().date_naive();
        timeline.update_entry(today, 0, "rewritten").unwrap();

        let entries = timeline.read(today).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].contains("rewritten"));
        assert!(entries[0].contains("\"hostname\":\"MacBook\""));
        assert!(entries[1].contains("\"hostname\":\"MacBook\""));
    }

    #[test]
    fn editing_a_missing_day_reports_not_found() {
        let tmp = TempDir::new().unwrap();
        let timeline = Timeline::new(tmp.path().to_path_buf());

        assert!(matches!(
            timeline.delete_entry(date(), 0),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn text_that_looks_like_json_is_not_mistaken_for_context() {
        let (_tmp, timeline) = seed(&["- [09:00:00] see {not json"]);

        timeline.update_entry(date(), 0, "edited").unwrap();

        assert_eq!(timeline.read(date()).unwrap(), vec!["- [09:00:00] edited"]);
    }
}
