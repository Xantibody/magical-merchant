use std::fs;
use std::path::Path;

use chrono::{Local, NaiveDate};

use crate::error::CoreError;
use crate::format::{format_note_markdown, format_timeline_line, DeviceContext};
use crate::path::{note_file_path, timeline_file_path};

fn ensure_dir(path: &Path) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

pub fn save_timeline_entry(
    base_dir: &Path,
    text: &str,
    context: &DeviceContext,
) -> Result<(), CoreError> {
    let now = Local::now();
    let file_path = timeline_file_path(base_dir, now.date_naive());
    ensure_dir(&file_path)?;

    let line = format_timeline_line(text, now, context);

    let mut content = if file_path.exists() {
        fs::read_to_string(&file_path)?
    } else {
        String::new()
    };

    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&line);
    content.push('\n');

    fs::write(&file_path, content)?;
    Ok(())
}

pub fn save_note(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &DeviceContext,
) -> Result<(), CoreError> {
    let now = Local::now();
    let file_path = note_file_path(base_dir, now);
    ensure_dir(&file_path)?;

    let content = format_note_markdown(body, tags, now, context)?;
    fs::write(&file_path, content)?;
    Ok(())
}

pub fn list_timeline_dates(base_dir: &Path) -> Result<Vec<NaiveDate>, CoreError> {
    let timeline_dir = base_dir.join("data").join("timeline");
    if !timeline_dir.exists() {
        return Ok(Vec::new());
    }

    let mut dates: Vec<NaiveDate> = fs::read_dir(&timeline_dir)?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".md")?;
            NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()
        })
        .collect();

    dates.sort_by(|a, b| b.cmp(a));
    Ok(dates)
}

pub fn read_timeline(base_dir: &Path, date: NaiveDate) -> Result<Vec<String>, CoreError> {
    let file_path = timeline_file_path(base_dir, date);
    if !file_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&file_path)?;
    let lines = content
        .lines()
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn test_save_note_creates_file() {
        let tmp = TempDir::new().unwrap();
        let tags = vec!["test".to_string()];
        save_note(tmp.path(), "# Title\nBody", &tags, &mock_context()).unwrap();

        let notes_dir = tmp.path().join("data/notes");
        assert!(notes_dir.exists());

        let files: Vec<_> = fs::read_dir(&notes_dir).unwrap().collect();
        assert_eq!(files.len(), 1);

        let content = fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
        assert!(content.contains("---"));
        let (fm, body): (crate::frontmatter::NoteFrontmatter, String) =
            crate::frontmatter::parse(&content).unwrap();
        assert_eq!(fm.tags, vec!["test"]);
        assert_eq!(body, "# Title\nBody");
    }

    #[test]
    fn test_save_note_empty_tags() {
        let tmp = TempDir::new().unwrap();
        save_note(tmp.path(), "body", &[], &mock_context()).unwrap();

        let notes_dir = tmp.path().join("data/notes");
        let files: Vec<_> = fs::read_dir(&notes_dir).unwrap().collect();
        let content = fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
        let (fm, _body): (crate::frontmatter::NoteFrontmatter, String) =
            crate::frontmatter::parse(&content).unwrap();
        assert!(fm.tags.is_empty());
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
