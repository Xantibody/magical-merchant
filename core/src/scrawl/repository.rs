use std::fs;
use std::io;
use std::path::PathBuf;

use chrono::{Local, NaiveDate};

use crate::error::CoreError;
use crate::scrawl::day::DayLog;
use crate::scrawl::migrate::migrate_scrawl_dir;
use crate::utils::device::{Context, Source};
use crate::utils::fs::{ensure_dir, write_atomic};
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
        // Every capture path ends here, so no entry point has to remember this. A failed move
        // is no reason to lose the entry: the next write tries again
        let _ = migrate_scrawl_dir(&self.base_dir);
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

    /// Returns the day's file as is. `None` if it does not exist.
    /// No `exists()` check first: opening the file tells whether it can be read, and in a
    /// search over every date one stat per day adds up.
    pub(crate) fn read_raw(&self, date: NaiveDate) -> Result<Option<String>, CoreError> {
        match fs::read_to_string(scrawl_file_path(&self.base_dir, date)) {
            Ok(content) => Ok(Some(content)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// `raw` is the line the writer read. Nothing is written if index does not point at that line.
    pub(crate) fn delete_entry(
        &self,
        date: NaiveDate,
        index: usize,
        raw: &str,
    ) -> Result<(), CoreError> {
        self.rewrite(date, |day| {
            // `expect_same_entry` has checked the range too: a missing line cannot
            // match the line that was read
            expect_same_entry(day, index, raw)?;
            day.entries_mut().remove(index);
            Ok(())
        })
    }

    /// Reads the day, hands it to `edit`, and writes it back unless it has become empty.
    /// It passes a `DayLog` rather than a `Vec` of lines because lines alone cannot restore
    /// the folded device information, so the same lines the reader saw cannot be rebuilt.
    ///
    /// Read to write is not atomic. `write_atomic` is atomic only for the single write; if
    /// the same day is written between `read_raw` -> `expect_same_entry` -> write, the old
    /// `DayLog` is checked and written back, and the record that slipped in is lost.
    /// Closing this needs everyone who writes this day file to take one lock:
    /// `save_entry`, and the sync's `write_under` / `delete_local_file`.
    // AIDEV-NOTE: read -> compare -> write is not atomic. Reusing SyncLock was rejected because capture fails with busy; exclusion is a separate PR
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

/// Checks that the line `index` points at now is the same `raw` the writer read.
///
/// Day files grow by appending, so index is only "the position at read time". If the sync or
/// the widget adds a line earlier in the day, the same index points at the record next to it.
///
/// The comparison is against the expanded line that `read` returned. The line on disk has
/// its device information folded into the frontmatter, which the writer never saw.
// AIDEV-NOTE: a mismatch is Stale, not NotFound: the way out is "re-read and retry", unlike a line that is gone
fn expect_same_entry(day: &DayLog, index: usize, raw: &str) -> Result<(), CoreError> {
    let Some(entry) = day.expanded_at(index) else {
        return Err(CoreError::NotFound(format!("scrawl entry {index}")));
    };
    if entry == raw {
        return Ok(());
    }
    Err(CoreError::Stale(format!("scrawl entry {index}")))
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

    /// A wrong deletion cannot be undone. If the line pointed at is not the one that was read,
    /// refuse without touching a single byte of the file.
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

    /// The comparison is against the form `read` returned. The line on disk has its device
    /// information folded into the frontmatter, so comparing it as is would refuse every
    /// deletion on a day that recorded a device.
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
        assert!(entries[0].contains("\"hostname\":\"MacBook\""));
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

    /// Appending to a day as it was actually saved (macOS and Android side by side, old format
    /// with the full context at the end of each line) must not change the meaning of a single
    /// existing record.
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
        // Today is a separate file, so the day above has not grown.
        assert_eq!(
            scrawl.read(today).unwrap().len(),
            usize::from(today != date())
        );
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
}
