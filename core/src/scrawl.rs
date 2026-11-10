pub(crate) mod day;
pub(crate) mod error;
pub(crate) mod migrate;
pub(crate) mod repository;

pub(crate) use repository::Scrawl;

use std::path::Path;

use chrono::NaiveDate;
use serde::Serialize;

use crate::error::CoreError;
use crate::utils::device::{Context, Source};

/// Adds one line to today's file.
///
/// `source` is the entry point the writer names itself as; the app, the CLI and the widget all go
/// through the same core function (the MCP server only reads Scrawl), so unless it is named here
/// the records cannot tell them apart.
pub fn save_scrawl_entry(
    base_dir: &Path,
    text: &str,
    context: &Context,
    source: Source,
) -> Result<(), CoreError> {
    Scrawl::new(base_dir.to_path_buf()).save_entry(text, context, source)
}

pub fn list_scrawl_dates(base_dir: &Path) -> Result<Vec<NaiveDate>, CoreError> {
    Scrawl::new(base_dir.to_path_buf()).list_dates()
}

pub fn read_scrawl(base_dir: &Path, date: NaiveDate) -> Result<Vec<String>, CoreError> {
    Scrawl::new(base_dir.to_path_buf()).read(date)
}

/// What `read_scrawl_days` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScrawlDays {
    /// Every date that has a record, newest first, as `list_scrawl_dates` returns them.
    pub dates: Vec<NaiveDate>,
    /// The days that were asked for, newest first.
    pub days: Vec<ScrawlDay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScrawlDay {
    pub date: NaiveDate,
    /// As `read_scrawl` returns them. Empty for a day nobody wrote on.
    pub entries: Vec<String>,
}

/// Every date that has a record, and the entries of the newest `recent` of them plus the days
/// named in `extra` (a calendar jump, "a year ago today"), in one call.
///
/// The app's Scrawl screen used to ask for the dates and then for each day on its own, one IPC
/// round trip per day. Like `read_scrawl` it only reads: a pre-rename `data/timeline/` is left
/// for the writers to move.
pub fn read_scrawl_days(
    base_dir: &Path,
    recent: usize,
    extra: &[NaiveDate],
) -> Result<ScrawlDays, CoreError> {
    let scrawl = Scrawl::new(base_dir.to_path_buf());
    let dates = scrawl.list_dates()?;
    let mut wanted: Vec<NaiveDate> = dates.iter().take(recent).chain(extra).copied().collect();
    wanted.sort_unstable_by(|a, b| b.cmp(a));
    wanted.dedup();
    let days = wanted
        .into_iter()
        .map(|date| {
            Ok(ScrawlDay {
                date,
                entries: scrawl.read(date)?,
            })
        })
        .collect::<Result<_, CoreError>>()?;
    Ok(ScrawlDays { dates, days })
}

/// `raw` is the line as the writer read it (exactly the form `read_scrawl` returned).
/// An index alone drifts with any append or sync that lands between the read and the write.
pub fn delete_scrawl_entry(
    base_dir: &Path,
    date: NaiveDate,
    index: usize,
    raw: &str,
) -> Result<(), CoreError> {
    Scrawl::new(base_dir.to_path_buf()).delete_entry(date, index, raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Local;
    use std::fs;
    use tempfile::TempDir;

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_save_scrawl_entry_creates_file() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "hello", &mock_context(), Source::App).unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let file = tmp.path().join("data/scrawl").join(format!("{today}.md"));
        assert!(file.exists());

        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("hello"));
        assert!(content.contains("battery"));
    }

    /// The app, the CLI and the widget all go through this one function (MCP only reads).
    /// The `s` at the end of the line is the only later clue to which entry point wrote it.
    #[test]
    fn a_saved_entry_names_the_tool_that_wrote_it() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "hello", &mock_context(), Source::Widget).unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let content =
            fs::read_to_string(tmp.path().join("data/scrawl").join(format!("{today}.md"))).unwrap();
        assert!(content.contains("\"s\":\"widget\""));
    }

    #[test]
    fn test_save_scrawl_entry_appends() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "first", &mock_context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &mock_context(), Source::App).unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let file = tmp.path().join("data/scrawl").join(format!("{today}.md"));
        let content = fs::read_to_string(&file).unwrap();

        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        assert!(lines[1].contains("second"));
    }

    #[test]
    fn test_read_scrawl_empty() {
        let tmp = TempDir::new().unwrap();
        let today = Local::now().date_naive();
        let lines = read_scrawl(tmp.path(), today).unwrap();
        assert!(lines.is_empty());
    }

    #[test]
    fn test_list_scrawl_dates_empty() {
        let tmp = TempDir::new().unwrap();
        let dates = list_scrawl_dates(tmp.path()).unwrap();
        assert!(dates.is_empty());
    }

    #[test]
    fn test_list_scrawl_dates_returns_sorted_desc() {
        let tmp = TempDir::new().unwrap();
        let scrawl_dir = tmp.path().join("data").join("scrawl");
        fs::create_dir_all(&scrawl_dir).unwrap();
        fs::write(scrawl_dir.join("2026-01-15.md"), "entry").unwrap();
        fs::write(scrawl_dir.join("2026-03-01.md"), "entry").unwrap();
        fs::write(scrawl_dir.join("2026-02-10.md"), "entry").unwrap();

        let dates = list_scrawl_dates(tmp.path()).unwrap();
        assert_eq!(dates.len(), 3);
        assert_eq!(dates[0], NaiveDate::from_ymd_opt(2026, 3, 1).unwrap());
        assert_eq!(dates[1], NaiveDate::from_ymd_opt(2026, 2, 10).unwrap());
        assert_eq!(dates[2], NaiveDate::from_ymd_opt(2026, 1, 15).unwrap());
    }

    #[test]
    fn test_list_scrawl_dates_skips_invalid_filenames() {
        let tmp = TempDir::new().unwrap();
        let scrawl_dir = tmp.path().join("data").join("scrawl");
        fs::create_dir_all(&scrawl_dir).unwrap();
        fs::write(scrawl_dir.join("2026-01-15.md"), "entry").unwrap();
        fs::write(scrawl_dir.join("README.md"), "readme").unwrap();
        fs::write(scrawl_dir.join("not-a-date.md"), "invalid").unwrap();

        let dates = list_scrawl_dates(tmp.path()).unwrap();
        assert_eq!(dates.len(), 1);
        assert_eq!(dates[0], NaiveDate::from_ymd_opt(2026, 1, 15).unwrap());
    }

    #[test]
    fn test_read_scrawl_groups_multiline_entries() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "line1\nline2", &mock_context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &mock_context(), Source::App).unwrap();

        let today = Local::now().date_naive();
        let entries = read_scrawl(tmp.path(), today).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].contains("line1\nline2"));
        assert!(entries[1].contains("second"));
    }

    fn ymd(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    /// One line per day, so each day's entries say which day they came from.
    fn seed_days(base: &Path, dates: &[&str]) {
        let dir = base.join("data").join("scrawl");
        fs::create_dir_all(&dir).unwrap();
        for date in dates {
            fs::write(
                dir.join(format!("{date}.md")),
                format!("- [09:00:00] {date}\n"),
            )
            .unwrap();
        }
    }

    fn entries_of(days: &ScrawlDays) -> Vec<(NaiveDate, Vec<String>)> {
        days.days
            .iter()
            .map(|day| (day.date, day.entries.clone()))
            .collect()
    }

    #[test]
    fn read_scrawl_days_is_empty_without_a_scrawl_directory() {
        let tmp = TempDir::new().unwrap();

        let days = read_scrawl_days(tmp.path(), 14, &[]).unwrap();

        assert!(days.dates.is_empty());
        assert!(days.days.is_empty());
    }

    #[test]
    fn read_scrawl_days_reads_the_newest_days_and_lists_every_date() {
        let tmp = TempDir::new().unwrap();
        seed_days(tmp.path(), &["2026-03-01", "2026-03-03", "2026-03-02"]);

        let days = read_scrawl_days(tmp.path(), 2, &[]).unwrap();

        assert_eq!(
            days.dates,
            vec![ymd("2026-03-03"), ymd("2026-03-02"), ymd("2026-03-01")]
        );
        assert_eq!(
            entries_of(&days),
            vec![
                (
                    ymd("2026-03-03"),
                    vec!["- [09:00:00] 2026-03-03".to_string()]
                ),
                (
                    ymd("2026-03-02"),
                    vec!["- [09:00:00] 2026-03-02".to_string()]
                ),
            ]
        );
    }

    /// A calendar jump or "a year ago today" asks for a day past the newest ones. It takes its
    /// place by date among them, and a day already among them is not read twice.
    #[test]
    fn read_scrawl_days_adds_older_days_asked_for_by_date() {
        let tmp = TempDir::new().unwrap();
        seed_days(
            tmp.path(),
            &["2025-03-03", "2026-03-01", "2026-03-02", "2026-03-03"],
        );

        let days = read_scrawl_days(
            tmp.path(),
            2,
            &[ymd("2025-03-03"), ymd("2026-03-03"), ymd("2026-03-01")],
        )
        .unwrap();

        let dates: Vec<NaiveDate> = days.days.iter().map(|day| day.date).collect();
        assert_eq!(
            dates,
            vec![
                ymd("2026-03-03"),
                ymd("2026-03-02"),
                ymd("2026-03-01"),
                ymd("2025-03-03")
            ]
        );
    }

    /// The calendar can name a day nobody wrote on. It comes back empty rather than failing
    /// the whole read, as `read_scrawl` does for that day alone.
    #[test]
    fn read_scrawl_days_returns_a_day_without_a_file_empty() {
        let tmp = TempDir::new().unwrap();
        seed_days(tmp.path(), &["2026-03-03"]);

        let days = read_scrawl_days(tmp.path(), 14, &[ymd("2026-01-01")]).unwrap();

        assert_eq!(
            entries_of(&days),
            vec![
                (
                    ymd("2026-03-03"),
                    vec!["- [09:00:00] 2026-03-03".to_string()]
                ),
                (ymd("2026-01-01"), Vec::new()),
            ]
        );
        assert_eq!(days.dates, vec![ymd("2026-03-03")]);
    }

    /// The entries are the same expanded lines `read_scrawl` returns, so the screen's later
    /// edit or delete of one compares against what it was given.
    #[test]
    fn read_scrawl_days_returns_what_read_scrawl_returns() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "line1\nline2", &mock_context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &mock_context(), Source::App).unwrap();
        let today = Local::now().date_naive();

        let days = read_scrawl_days(tmp.path(), 14, &[]).unwrap();

        assert_eq!(
            entries_of(&days),
            vec![(today, read_scrawl(tmp.path(), today).unwrap())]
        );
    }

    /// A read never migrates: the writers move a pre-rename `data/timeline/`, and a read that
    /// moved it would make a read-only caller write.
    #[test]
    fn read_scrawl_days_leaves_a_pre_rename_tree_where_it_is() {
        let tmp = TempDir::new().unwrap();
        let legacy = tmp.path().join("data").join("timeline");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("2026-03-20.md"), "- [09:00:00] 朝\n").unwrap();

        read_scrawl_days(tmp.path(), 14, &[ymd("2026-03-20")]).unwrap();

        assert!(legacy.join("2026-03-20.md").exists());
        assert!(!tmp.path().join("data").join("scrawl").exists());
    }

    #[test]
    fn test_read_scrawl_returns_entries() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "first", &mock_context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &mock_context(), Source::App).unwrap();

        let today = Local::now().date_naive();
        let lines = read_scrawl(tmp.path(), today).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        assert!(lines[1].contains("second"));
    }
}
