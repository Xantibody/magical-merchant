use chrono::{DateTime, Local, NaiveDate};
use std::path::{Path, PathBuf};

pub fn timeline_file_path(base_dir: &Path, date: NaiveDate) -> PathBuf {
    base_dir
        .join("data")
        .join("timeline")
        .join(format!("{}.md", date.format("%Y-%m-%d")))
}

pub fn note_file_path(base_dir: &Path, timestamp: DateTime<Local>) -> PathBuf {
    base_dir
        .join("data")
        .join("notes")
        .join(format!("{}.md", timestamp.format("%Y%m%d_%H%M%S")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_timeline_file_path() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 20).unwrap();
        let path = timeline_file_path(Path::new("/app"), date);
        assert_eq!(path, PathBuf::from("/app/data/timeline/2026-03-20.md"));
    }

    #[test]
    fn test_note_file_path() {
        let ts = Local.with_ymd_and_hms(2026, 3, 20, 14, 30, 45).unwrap();
        let path = note_file_path(Path::new("/app"), ts);
        assert_eq!(path, PathBuf::from("/app/data/notes/20260320_143045.md"));
    }
}
