use std::fs;
use std::path::Path;

use chrono::Local;

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

    let content = format_note_markdown(body, tags, now, context);
    fs::write(&file_path, content)?;
    Ok(())
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
        assert!(content.contains("tags: [\"test\"]"));
        assert!(content.contains("# Title\nBody"));
    }

    #[test]
    fn test_save_note_empty_tags() {
        let tmp = TempDir::new().unwrap();
        save_note(tmp.path(), "body", &[], &mock_context()).unwrap();

        let notes_dir = tmp.path().join("data/notes");
        let files: Vec<_> = fs::read_dir(&notes_dir).unwrap().collect();
        let content = fs::read_to_string(files[0].as_ref().unwrap().path()).unwrap();
        assert!(content.contains("tags: []"));
    }
}
