//! Taking one line out of a day.

use std::fs;
use std::path::Path;

use super::day::{DayLog, expect_same_entry, scrawl_file_path};
use super::journal::read_raw;
use crate::error::CoreError;
use crate::services::files::write_atomic;
use crate::utils::clock::Day;

/// `raw` is the line as the writer read it (exactly the form `read_scrawl` returned).
/// An index alone drifts with any append or sync that lands between the read and the write.
///
/// Nothing is written if index does not point at that line.
pub fn delete_scrawl_entry(
    base_dir: &Path,
    date: Day,
    index: usize,
    raw: &str,
) -> Result<(), CoreError> {
    rewrite(base_dir, date, |day| {
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
/// `save_scrawl_entry`, and the sync's `write_under` / `delete_local_file`.
// AIDEV-NOTE: read -> compare -> write is not atomic. Reusing SyncLock was rejected because capture fails with busy; exclusion is a separate PR
fn rewrite<F>(base_dir: &Path, date: Day, edit: F) -> Result<(), CoreError>
where
    F: FnOnce(&mut DayLog) -> Result<(), CoreError>,
{
    let file_path = scrawl_file_path(base_dir, date);
    let Some(content) = read_raw(base_dir, date)? else {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::scrawl::capture::save_scrawl_entry;
    use crate::domain::scrawl::day::SCRAWL_DIR;
    use crate::domain::scrawl::journal::read_scrawl;
    use crate::services::files::ensure_dir;
    use crate::utils::device::{Context, Source};
    use crate::utils::paths;
    use tempfile::TempDir;

    const DATE: &str = "2026-08-04";

    fn date() -> Day {
        Day::parse_ymd(DATE).unwrap()
    }

    fn seed(lines: &[&str]) -> TempDir {
        let tmp = TempDir::new().unwrap();
        let path = scrawl_file_path(tmp.path(), date());
        ensure_dir(&path).unwrap();
        fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
        tmp
    }

    /// A wrong deletion cannot be undone. If the line pointed at is not the one that was read,
    /// refuse without touching a single byte of the file.
    #[test]
    fn delete_entry_refuses_a_line_it_did_not_read() {
        let tmp = seed(&["- [08:00:00] slipped in", "- [09:00:00] the one I read"]);
        let before = fs::read_to_string(scrawl_file_path(tmp.path(), date())).unwrap();

        let result = delete_scrawl_entry(tmp.path(), date(), 0, "- [09:00:00] the one I read");

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
        let context = Context {
            battery: Some(56),
            os: "macos".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        save_scrawl_entry(tmp.path(), "first", &context, Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &context, Source::App).unwrap();

        let today = Day::today_local();
        let raw = read_scrawl(tmp.path(), today).unwrap()[1].clone();
        assert!(raw.contains("\"hostname\":\"MacBook\""));

        delete_scrawl_entry(tmp.path(), today, 1, &raw).unwrap();

        let entries = read_scrawl(tmp.path(), today).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].contains("first"));
        assert!(entries[0].contains("\"hostname\":\"MacBook\""));
    }

    #[test]
    fn delete_entry_removes_just_that_entry() {
        let tmp = seed(&[
            "- [09:00:00] first",
            "- [10:00:00] second",
            "- [11:00:00] third",
        ]);

        delete_scrawl_entry(tmp.path(), date(), 1, "- [10:00:00] second").unwrap();

        assert_eq!(
            read_scrawl(tmp.path(), date()).unwrap(),
            vec!["- [09:00:00] first", "- [11:00:00] third"]
        );
    }

    #[test]
    fn delete_entry_removes_the_file_once_the_day_is_empty() {
        let tmp = seed(&["- [09:00:00] only"]);

        delete_scrawl_entry(tmp.path(), date(), 0, "- [09:00:00] only").unwrap();

        assert!(!scrawl_file_path(tmp.path(), date()).exists());
        assert!(read_scrawl(tmp.path(), date()).unwrap().is_empty());
    }

    #[test]
    fn delete_entry_rejects_an_index_past_the_end() {
        let tmp = seed(&["- [09:00:00] only"]);

        let result = delete_scrawl_entry(tmp.path(), date(), 5, "- [09:00:00] only");

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn editing_a_missing_day_reports_not_found() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            delete_scrawl_entry(tmp.path(), date(), 0, "- [09:00:00] gone"),
            Err(CoreError::NotFound(_))
        ));
    }

    /// Deleting does not migrate `data/timeline/` first, unlike a capture. On a tree nothing
    /// has migrated yet the day is not found under `data/scrawl/`, and the old directory
    /// stays where it is.
    #[test]
    fn deleting_on_a_pre_rename_tree_is_not_found_and_moves_nothing() {
        let tmp = TempDir::new().unwrap();
        let legacy = paths::data_dir(tmp.path()).join("timeline");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join(format!("{DATE}.md")), "- [09:00:00] old\n").unwrap();

        let result = delete_scrawl_entry(tmp.path(), date(), 0, "- [09:00:00] old");

        assert!(matches!(result, Err(CoreError::NotFound(_))));
        assert_eq!(
            fs::read_to_string(legacy.join(format!("{DATE}.md"))).unwrap(),
            "- [09:00:00] old\n"
        );
        assert!(!paths::data_dir(tmp.path()).join(SCRAWL_DIR).exists());
    }
}
