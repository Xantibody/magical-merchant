pub mod error;
mod model;
pub mod repository;

pub use model::NoteSummary;
pub use repository::{FsNoteRepository, NoteRepository};

use std::path::{Path, PathBuf};

use crate::error::CoreError;
use crate::shared::context::DeviceContext;
use crate::shared::validated::NoteFilename;

pub fn create_draft_note(
    base_dir: &Path,
    body: &str,
    tags: &[String],
    context: &DeviceContext,
) -> Result<PathBuf, CoreError> {
    FsNoteRepository::new(base_dir.to_path_buf()).create(body, tags, context)
}

pub fn update_note(
    file_path: &Path,
    body: &str,
    tags: &[String],
    context: &DeviceContext,
) -> Result<(), CoreError> {
    // update_note takes a file_path directly, so we use a dummy base_dir
    // The repository's update method doesn't need base_dir for this operation
    let base_dir = file_path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .unwrap_or(Path::new("/"));
    FsNoteRepository::new(base_dir.to_path_buf()).update(file_path, body, tags, context)
}

pub fn list_notes(base_dir: &Path) -> Result<Vec<NoteSummary>, CoreError> {
    FsNoteRepository::new(base_dir.to_path_buf()).list()
}

pub fn read_note(file_path: &Path) -> Result<String, CoreError> {
    Ok(std::fs::read_to_string(file_path)?)
}

pub fn read_note_by_filename(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<String, CoreError> {
    FsNoteRepository::new(base_dir.to_path_buf()).read(filename)
}

pub fn delete_note(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    FsNoteRepository::new(base_dir.to_path_buf()).delete(filename)
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
}
