//! Reading the journal back: which days have records, and what each day holds.
//!
//! It only reads, so a pre-rename `data/timeline/` is left for the writers to move.

use std::path::Path;

use serde::Serialize;

use super::day::{DayLog, SCRAWL_DIR, day_of_filename, scrawl_file_path};
use super::entry::{ScrawlEntry, parse_scrawl_entry};
use crate::domain::data::data_dir;
use crate::domain::tags::tag;
use crate::services::files::{entry_names, read_if_present};
use crate::utils::clock::Day;
use crate::utils::error::CoreError;

/// Every date that has a record, newest first.
pub fn list_scrawl_dates(base_dir: &Path) -> Result<Vec<Day>, CoreError> {
    let mut dates: Vec<Day> = entry_names(&data_dir(base_dir).join(SCRAWL_DIR))?
        .iter()
        .filter_map(|name| day_of_filename(name))
        .collect();

    dates.sort_by(|a, b| b.cmp(a));
    Ok(dates)
}

pub fn read_scrawl(base_dir: &Path, date: Day) -> Result<Vec<String>, CoreError> {
    Ok(read_raw(base_dir, date)?
        .map(|content| DayLog::parse(&content).expanded())
        .unwrap_or_default())
}

/// Returns the day's file as is. `None` if it does not exist.
/// No `exists()` check first: opening the file tells whether it can be read, and in a
/// search over every date one stat per day adds up.
pub(crate) fn read_raw(base_dir: &Path, date: Day) -> Result<Option<String>, CoreError> {
    read_if_present(&scrawl_file_path(base_dir, date))
}

/// What `read_scrawl_days` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScrawlDays {
    /// Every date that has a record, newest first, as `list_scrawl_dates` returns them.
    pub dates: Vec<Day>,
    /// The days that were asked for, newest first.
    pub days: Vec<ScrawlDay>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScrawlDay {
    pub date: Day,
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
    extra: &[Day],
) -> Result<ScrawlDays, CoreError> {
    let dates = list_scrawl_dates(base_dir)?;
    let mut wanted: Vec<Day> = dates.iter().take(recent).chain(extra).copied().collect();
    wanted.sort_unstable_by(|a, b| b.cmp(a));
    wanted.dedup();
    let days = wanted
        .into_iter()
        .map(|date| {
            Ok(ScrawlDay {
                date,
                entries: read_scrawl(base_dir, date)?,
            })
        })
        .collect::<Result<_, CoreError>>()?;
    Ok(ScrawlDays { dates, days })
}

/// One Scrawl entry with the day it was written on and its place within that day.
#[derive(Debug, Clone, PartialEq)]
pub struct DatedEntry {
    pub day: Day,
    /// Its position within the day, as `read_scrawl` orders them.
    pub index: usize,
    pub entry: ScrawlEntry,
}

/// What `entries_between` returns.
#[derive(Debug, Clone, PartialEq)]
pub struct EntriesBetween {
    /// Oldest first.
    pub entries: Vec<DatedEntry>,
    /// Whether more entries matched than `limit` let through.
    pub truncated: bool,
}

/// The entries written from `from` to `to`, both days included, oldest first.
///
/// With `tag`, only the entries whose text carries it, matched as the search field
/// matches: the `#` and the case of the argument do not matter. At most `limit` come
/// back, and `truncated` says whether more matched: a journal piles up over years, and an
/// unbounded read lets one call use up a reader's context.
///
/// Only the days that have a file are opened. Opening every day in the range piles up a
/// wasted stat for each day that was never written. Like `read_scrawl` it only reads.
pub fn entries_between(
    base_dir: &Path,
    from: Day,
    to: Day,
    tag: Option<&str>,
    limit: usize,
) -> Result<EntriesBetween, CoreError> {
    let tag = tag.map(tag::normalize);
    let mut days: Vec<Day> = list_scrawl_dates(base_dir)?
        .into_iter()
        .filter(|day| (from..=to).contains(day))
        .collect();
    days.sort_unstable();

    let mut entries = Vec::new();
    for day in days {
        for (index, line) in read_scrawl(base_dir, day)?.iter().enumerate() {
            let entry = parse_scrawl_entry(line);
            if tag.as_ref().is_some_and(|wanted| {
                !tag::parse(&entry.text)
                    .iter()
                    .any(|own| tag::same_tag(own, wanted))
            }) {
                continue;
            }
            if entries.len() >= limit {
                return Ok(EntriesBetween {
                    entries,
                    truncated: true,
                });
            }
            entries.push(DatedEntry { day, index, entry });
        }
    }
    Ok(EntriesBetween {
        entries,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::{Context, Source};
    use crate::domain::scrawl::capture::save_scrawl_entry;
    use std::fs;
    use tempfile::TempDir;

    /// The texts and days of a range read, in the order they came.
    fn read_between(
        base: &Path,
        from: &str,
        to: &str,
        tag: Option<&str>,
        limit: usize,
    ) -> (Vec<(String, usize, String)>, bool) {
        let read = entries_between(base, ymd(from), ymd(to), tag, limit).unwrap();
        let entries = read
            .entries
            .into_iter()
            .map(|dated| (dated.day.ymd(), dated.index, dated.entry.text))
            .collect();
        (entries, read.truncated)
    }

    fn day_file(base: &Path, date: &str, lines: &str) {
        let dir = base.join("data").join("scrawl");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{date}.md")), lines).unwrap();
    }

    #[test]
    fn a_range_reads_the_days_inside_it_oldest_first() {
        let tmp = TempDir::new().unwrap();
        day_file(tmp.path(), "2026-01-14", "- [09:00:00] eve\n");
        day_file(tmp.path(), "2026-01-15", "- [09:00:00] a\n- [10:00:00] b\n");
        day_file(tmp.path(), "2026-02-10", "- [09:00:00] c\n");
        day_file(tmp.path(), "2026-03-01", "- [09:00:00] after\n");

        let (entries, truncated) = read_between(tmp.path(), "2026-01-15", "2026-02-10", None, 500);

        assert_eq!(
            entries,
            [
                ("2026-01-15".to_string(), 0, "a".to_string()),
                ("2026-01-15".to_string(), 1, "b".to_string()),
                ("2026-02-10".to_string(), 0, "c".to_string()),
            ]
        );
        assert!(!truncated);
    }

    /// The `#` and the case of the argument do not matter; the index stays the entry's place
    /// in its day, not in the result.
    #[test]
    fn a_tag_keeps_the_entries_that_carry_it() {
        let tmp = TempDir::new().unwrap();
        day_file(
            tmp.path(),
            "2026-01-15",
            "- [09:00:00] rest\n- [10:00:00] ran #CognitiveBias\n",
        );

        for tag in ["cognitivebias", "#COGNITIVEBIAS"] {
            let (entries, _) = read_between(tmp.path(), "2026-01-01", "2026-12-31", Some(tag), 500);

            assert_eq!(
                entries,
                [(
                    "2026-01-15".to_string(),
                    1,
                    "ran #CognitiveBias".to_string()
                )],
                "{tag}"
            );
        }
    }

    #[test]
    fn a_range_stops_at_the_limit_and_says_so() {
        let tmp = TempDir::new().unwrap();
        day_file(
            tmp.path(),
            "2026-01-15",
            "- [09:00:00] a\n- [10:00:00] b\n- [11:00:00] c\n",
        );

        let (two, truncated) = read_between(tmp.path(), "2026-01-01", "2026-12-31", None, 2);
        let (three, all) = read_between(tmp.path(), "2026-01-01", "2026-12-31", None, 3);

        assert_eq!(two.len(), 2);
        assert!(truncated);
        assert_eq!(three.len(), 3);
        assert!(!all, "exactly the limit is not more than it");
    }

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_read_scrawl_empty() {
        let tmp = TempDir::new().unwrap();
        let today = Day::today_local();
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
        assert_eq!(dates[0], Day::new(2026, 3, 1).unwrap());
        assert_eq!(dates[1], Day::new(2026, 2, 10).unwrap());
        assert_eq!(dates[2], Day::new(2026, 1, 15).unwrap());
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
        assert_eq!(dates[0], Day::new(2026, 1, 15).unwrap());
    }

    /// Which file names count as a day. What the date parser lets through decides which
    /// files the Scrawl screen and search can see.
    #[test]
    fn which_day_files_are_listed() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data").join(SCRAWL_DIR);
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "2026-03-20.md",
            "2026-3-2.md",
            "notes.md",
            "2026-02-30.md",
            "20260321.md",
            "2026-03-22x.md",
            " 2026-03-23.md",
            "2026-03-24.txt",
            "+2026-03-25.md",
        ] {
            fs::write(dir.join(name), "- [09:00:00] x\n").unwrap();
        }

        let dates: Vec<String> = list_scrawl_dates(tmp.path())
            .unwrap()
            .iter()
            .map(ToString::to_string)
            .collect();

        // Unpadded fields, a leading space and a `+` sign are let through; `2026-3-2.md` is
        // listed as 2026-03-02 although no file of that name exists
        assert_eq!(
            dates,
            vec!["2026-03-25", "2026-03-23", "2026-03-20", "2026-03-02"]
        );
    }

    #[test]
    fn test_read_scrawl_groups_multiline_entries() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "line1\nline2", &mock_context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &mock_context(), Source::App).unwrap();

        let today = Day::today_local();
        let entries = read_scrawl(tmp.path(), today).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].contains("line1\nline2"));
        assert!(entries[1].contains("second"));
    }

    fn ymd(text: &str) -> Day {
        Day::parse_ymd(text).unwrap()
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

    fn entries_of(days: &ScrawlDays) -> Vec<(Day, Vec<String>)> {
        days.days
            .iter()
            .map(|day| (day.date, day.entries.clone()))
            .collect()
    }

    /// The Scrawl screen reads these dates over IPC and builds its day keys from them, so
    /// the spelling is a contract: zero-padded `YYYY-MM-DD`.
    #[test]
    fn scrawl_days_serialize_dates_as_iso_days() {
        let days = ScrawlDays {
            dates: vec![ymd("2026-03-03"), ymd("0999-01-02")],
            days: vec![ScrawlDay {
                date: ymd("2026-03-03"),
                entries: vec![],
            }],
        };

        assert_eq!(
            serde_json::to_string(&days).unwrap(),
            r#"{"dates":["2026-03-03","0999-01-02"],"days":[{"date":"2026-03-03","entries":[]}]}"#
        );
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

        let dates: Vec<Day> = days.days.iter().map(|day| day.date).collect();
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
        let today = Day::today_local();

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

        let today = Day::today_local();
        let lines = read_scrawl(tmp.path(), today).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        assert!(lines[1].contains("second"));
    }
}
