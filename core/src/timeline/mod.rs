pub mod repository;

pub use repository::{FsTimelineRepository, TimelineRepository};

use std::path::Path;

use chrono::NaiveDate;

use crate::error::CoreError;
use crate::shared::context::DeviceContext;

pub fn save_timeline_entry(
    base_dir: &Path,
    text: &str,
    context: &DeviceContext,
) -> Result<(), CoreError> {
    FsTimelineRepository::new(base_dir.to_path_buf()).save_entry(text, context)
}

pub fn list_timeline_dates(base_dir: &Path) -> Result<Vec<NaiveDate>, CoreError> {
    FsTimelineRepository::new(base_dir.to_path_buf()).list_dates()
}

pub fn read_timeline(base_dir: &Path, date: NaiveDate) -> Result<Vec<String>, CoreError> {
    FsTimelineRepository::new(base_dir.to_path_buf()).read(date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Local;
    use std::fs;
    use tempfile::TempDir;

    fn mock_context() -> DeviceContext {
        DeviceContext::mock()
    }

    #[test]
    fn test_save_timeline_entry_creates_file() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "hello", &mock_context()).unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let file = tmp.path().join("data/timeline").join(format!("{today}.md"));
        assert!(file.exists());

        let content = fs::read_to_string(&file).unwrap();
        assert!(content.contains("hello"));
        assert!(content.contains("battery"));
    }

    #[test]
    fn test_save_timeline_entry_appends() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "first", &mock_context()).unwrap();
        save_timeline_entry(tmp.path(), "second", &mock_context()).unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let file = tmp.path().join("data/timeline").join(format!("{today}.md"));
        let content = fs::read_to_string(&file).unwrap();

        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        assert!(lines[1].contains("second"));
    }

    #[test]
    fn test_read_timeline_empty() {
        let tmp = TempDir::new().unwrap();
        let today = Local::now().date_naive();
        let lines = read_timeline(tmp.path(), today).unwrap();
        assert!(lines.is_empty());
    }

    #[test]
    fn test_list_timeline_dates_empty() {
        let tmp = TempDir::new().unwrap();
        let dates = list_timeline_dates(tmp.path()).unwrap();
        assert!(dates.is_empty());
    }

    #[test]
    fn test_list_timeline_dates_returns_sorted_desc() {
        let tmp = TempDir::new().unwrap();
        let timeline_dir = tmp.path().join("data").join("timeline");
        fs::create_dir_all(&timeline_dir).unwrap();
        fs::write(timeline_dir.join("2026-01-15.md"), "entry").unwrap();
        fs::write(timeline_dir.join("2026-03-01.md"), "entry").unwrap();
        fs::write(timeline_dir.join("2026-02-10.md"), "entry").unwrap();

        let dates = list_timeline_dates(tmp.path()).unwrap();
        assert_eq!(dates.len(), 3);
        assert_eq!(dates[0], NaiveDate::from_ymd_opt(2026, 3, 1).unwrap());
        assert_eq!(dates[1], NaiveDate::from_ymd_opt(2026, 2, 10).unwrap());
        assert_eq!(dates[2], NaiveDate::from_ymd_opt(2026, 1, 15).unwrap());
    }

    #[test]
    fn test_list_timeline_dates_skips_invalid_filenames() {
        let tmp = TempDir::new().unwrap();
        let timeline_dir = tmp.path().join("data").join("timeline");
        fs::create_dir_all(&timeline_dir).unwrap();
        fs::write(timeline_dir.join("2026-01-15.md"), "entry").unwrap();
        fs::write(timeline_dir.join("README.md"), "readme").unwrap();
        fs::write(timeline_dir.join("not-a-date.md"), "invalid").unwrap();

        let dates = list_timeline_dates(tmp.path()).unwrap();
        assert_eq!(dates.len(), 1);
        assert_eq!(dates[0], NaiveDate::from_ymd_opt(2026, 1, 15).unwrap());
    }

    #[test]
    fn test_read_timeline_returns_entries() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "first", &mock_context()).unwrap();
        save_timeline_entry(tmp.path(), "second", &mock_context()).unwrap();

        let today = Local::now().date_naive();
        let lines = read_timeline(tmp.path(), today).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("first"));
        assert!(lines[1].contains("second"));
    }
}
