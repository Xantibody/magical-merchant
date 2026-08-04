use std::fs;
use std::path::PathBuf;

use chrono::{Local, NaiveDate};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::fs::ensure_dir;
use crate::utils::markdown::{format_timeline_line, split_context_json, split_time_prefix};
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

        let line = format_timeline_line(text, now, context);

        let mut day_log = if file_path.exists() {
            fs::read_to_string(&file_path)?
        } else {
            String::new()
        };

        if !day_log.is_empty() && !day_log.ends_with('\n') {
            day_log.push('\n');
        }
        day_log.push_str(&line);
        day_log.push('\n');

        fs::write(&file_path, day_log)?;
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
        let file_path = timeline_file_path(&self.base_dir, date);
        if !file_path.exists() {
            return Ok(Vec::new());
        }
        Ok(split_entries(&fs::read_to_string(&file_path)?))
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
        if !file_path.exists() {
            return Err(CoreError::NotFound(file_path.to_string_lossy().to_string()));
        }

        let mut entries = split_entries(&fs::read_to_string(&file_path)?);
        edit(&mut entries)?;

        if entries.is_empty() {
            fs::remove_file(&file_path)?;
            return Ok(());
        }

        let mut day_log = entries.join("\n");
        day_log.push('\n');
        fs::write(&file_path, day_log)?;
        Ok(())
    }
}

/// エントリは "- [" で始まる行から次の "- [" まで（本文に改行を含み得る）
fn split_entries(content: &str) -> Vec<String> {
    let mut entries: Vec<String> = Vec::new();
    for line in content.lines() {
        if line.starts_with("- [") || entries.is_empty() {
            if line.is_empty() {
                continue;
            }
            entries.push(line.to_string());
        } else if let Some(last) = entries.last_mut() {
            last.push('\n');
            last.push_str(line);
        }
    }
    entries
        .into_iter()
        .map(|e| e.trim_end().to_string())
        .collect()
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
