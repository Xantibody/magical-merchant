use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local};
use serde::Serialize;

use crate::error::CoreError;
use crate::format::{format_note_markdown, DeviceContext};
use crate::frontmatter::{self, NoteFrontmatter};
use crate::path::note_file_path;

fn ensure_dir(path: &Path) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

pub fn create_draft_note(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &DeviceContext,
) -> Result<PathBuf, CoreError> {
    let now = Local::now();
    let file_path = note_file_path(base_dir, now);
    ensure_dir(&file_path)?;

    let content = format_note_markdown(body, tags, now, context)?;
    fs::write(&file_path, content)?;
    Ok(file_path)
}

pub fn update_note(
    file_path: &Path,
    body: &str,
    tags: &[String],
    context: &DeviceContext,
) -> Result<(), CoreError> {
    let now = Local::now();
    let content = format_note_markdown(body, tags, now, context)?;
    fs::write(file_path, content)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteSummary {
    pub path: PathBuf,
    pub filename: String,
    pub time: Option<DateTime<FixedOffset>>,
    pub tags: Vec<String>,
    pub preview: String,
}

pub fn list_notes(base_dir: &Path) -> Result<Vec<NoteSummary>, CoreError> {
    let notes_dir = base_dir.join("data").join("notes");
    if !notes_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<_> = fs::read_dir(&notes_dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));

    let summaries = entries
        .into_iter()
        .map(|entry| {
            let path = entry.path();
            let filename = entry.file_name().to_string_lossy().to_string();
            let content = fs::read_to_string(&path).unwrap_or_default();
            let (time, tags, preview) = parse_note_content(&content);
            NoteSummary {
                path,
                filename,
                time,
                tags,
                preview,
            }
        })
        .collect();

    Ok(summaries)
}

pub fn read_note(file_path: &Path) -> Result<String, CoreError> {
    Ok(fs::read_to_string(file_path)?)
}

fn parse_note_content(content: &str) -> (Option<DateTime<FixedOffset>>, Vec<String>, String) {
    match frontmatter::parse::<NoteFrontmatter>(content) {
        Ok((fm, body)) => {
            let preview: String = body.chars().take(100).collect();
            (Some(fm.time), fm.tags, preview)
        }
        Err(_) => {
            let preview: String = content.chars().take(100).collect();
            (None, Vec::new(), preview)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mock_context() -> DeviceContext {
        DeviceContext::mock()
    }

    #[test]
    fn test_create_draft_note_returns_path() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "draft body", &[], &mock_context()).unwrap();
        assert!(path.exists());
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("draft body"));
    }

    #[test]
    fn test_update_note_overwrites() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(
            tmp.path(),
            "original",
            &["tag1".to_string()],
            &mock_context(),
        )
        .unwrap();

        update_note(&path, "updated", &["tag2".to_string()], &mock_context()).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("updated"));
        assert!(content.contains("tag2"));
        assert!(!content.contains("original"));
    }

    #[test]
    fn test_list_notes_empty() {
        let tmp = TempDir::new().unwrap();
        let notes = list_notes(tmp.path()).unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn test_list_notes_returns_summaries() {
        let tmp = TempDir::new().unwrap();
        let tags = vec!["rust".to_string(), "test".to_string()];
        create_draft_note(
            tmp.path(),
            "# Hello\nBody text here",
            &tags,
            &mock_context(),
        )
        .unwrap();

        let notes = list_notes(tmp.path()).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].tags, vec!["rust", "test"]);
        assert!(notes[0].time.is_some());
        assert!(notes[0].preview.contains("Hello"));
    }

    #[test]
    fn test_read_note() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "full content", &[], &mock_context()).unwrap();
        let content = read_note(&path).unwrap();
        assert!(content.contains("full content"));
    }

    #[test]
    fn test_parse_note_content() {
        use chrono::TimeZone;
        let fm = NoteFrontmatter {
            time: FixedOffset::east_opt(9 * 3600)
                .unwrap()
                .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
                .unwrap(),
            tags: vec!["a".to_string(), "b".to_string()],
            context: Some(crate::frontmatter::ContextMeta {
                battery: 50,
                is_charging: false,
            }),
        };
        let content = frontmatter::render(&fm, "# Title\nBody").unwrap();
        let (time, tags, preview) = parse_note_content(&content);
        assert!(time.is_some());
        assert_eq!(tags, vec!["a", "b"]);
        assert!(preview.contains("# Title"));
    }
}
