pub(crate) mod day;
pub(crate) mod error;
pub(crate) mod migrate;
pub(crate) mod repository;

pub(crate) use repository::Scrawl;

use std::path::Path;

use chrono::NaiveDate;

use crate::error::CoreError;
use crate::utils::device::{Context, Source};

/// Adds one line to today's file. `source` is the entry point the writer names itself as;
/// the app, the CLI and the widget all go through the same core function (the MCP server
/// only reads Scrawl), so unless it is named here the records cannot tell them apart.
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

/// `raw` is the line as the writer read it (exactly the form `read_scrawl` returned).
/// An index alone drifts with any append or sync that lands between the read and the write.
pub fn update_scrawl_entry(
    base_dir: &Path,
    date: NaiveDate,
    index: usize,
    raw: &str,
    text: &str,
) -> Result<(), CoreError> {
    Scrawl::new(base_dir.to_path_buf()).update_entry(date, index, raw, text)
}

/// `raw` is the same as in `update_scrawl_entry`: the line as the writer read it.
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
