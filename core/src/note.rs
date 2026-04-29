use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local};
use serde::Serialize;

use crate::error::CoreError;
use crate::infra::fs_helpers::ensure_dir;
use crate::infra::markdown::format_note_markdown;
use crate::infra::paths::note_file_path;
use crate::shared::context::DeviceContext;
use crate::shared::frontmatter::{self, NoteFrontmatter};
use crate::shared::validated::NoteFilename;

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
    let entries = crate::infra::fs_helpers::list_md_files(&notes_dir)?;

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

pub fn read_note_by_filename(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<String, CoreError> {
    let fname = filename.as_str();
    let notes_dir = base_dir.join("data").join("notes");
    let file_path = notes_dir.join(fname);

    if !file_path.exists() {
        return Err(CoreError::NotFound(file_path.to_string_lossy().to_string()));
    }

    let canonical_notes_dir = fs::canonicalize(&notes_dir)?;
    let canonical_file_path = fs::canonicalize(&file_path)?;
    if !canonical_file_path.starts_with(&canonical_notes_dir) {
        return Err(CoreError::PathTraversal(fname.to_string()));
    }

    Ok(fs::read_to_string(canonical_file_path)?)
}

pub fn delete_note(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    let fname = filename.as_str();
    let notes_dir = base_dir.join("data").join("notes");
    let file_path = notes_dir.join(fname);

    if !file_path.exists() {
        return Err(CoreError::NotFound(file_path.to_string_lossy().to_string()));
    }

    let canonical_notes_dir = fs::canonicalize(&notes_dir)?;
    let canonical_file_path = fs::canonicalize(&file_path)?;
    if !canonical_file_path.starts_with(&canonical_notes_dir) {
        return Err(CoreError::PathTraversal(fname.to_string()));
    }

    fs::remove_file(canonical_file_path)?;
    Ok(())
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
    fn test_delete_note_success() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "to delete", &[], &mock_context()).unwrap();
        assert!(path.exists());
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();
        delete_note(tmp.path(), &note_filename).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn test_delete_note_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let note_filename = NoteFilename::parse("nonexistent.md").unwrap();
        let result = delete_note(tmp.path(), &note_filename);
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_delete_note_path_traversal() {
        assert!(NoteFilename::parse("../etc/passwd").is_err());
    }

    #[test]
    fn test_delete_note_rejects_absolute_path() {
        assert!(NoteFilename::parse("/tmp/evil.md").is_err());
    }

    #[test]
    fn test_read_note_by_filename() {
        let tmp = TempDir::new().unwrap();
        let path = create_draft_note(tmp.path(), "readable content", &[], &mock_context()).unwrap();
        let fname = path.file_name().unwrap().to_str().unwrap();
        let note_filename = NoteFilename::parse(fname).unwrap();
        let content = read_note_by_filename(tmp.path(), &note_filename).unwrap();
        assert!(content.contains("readable content"));
    }

    #[test]
    fn test_read_note_by_filename_path_traversal() {
        assert!(NoteFilename::parse("../etc/passwd").is_err());
    }

    #[test]
    fn test_read_note_by_filename_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/notes")).unwrap();
        let note_filename = NoteFilename::parse("nonexistent.md").unwrap();
        let result = read_note_by_filename(tmp.path(), &note_filename);
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_validate_rejects_non_md_extension() {
        assert!(NoteFilename::parse("evil.txt").is_err());
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
            context: Some(crate::shared::frontmatter::ContextMeta {
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
