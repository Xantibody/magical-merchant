use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;

use crate::error::CoreError;
use crate::utils::fs::{ensure_dir, list_md_files};
use crate::utils::markdown::format_note_markdown;
use crate::utils::paths::note_file_path;
use crate::utils::device::Context;
use crate::utils::validated::NoteFilename;

use super::NoteSummary;

pub struct Notes {
    base_dir: PathBuf,
}

impl Notes {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn notes_dir(&self) -> PathBuf {
        self.base_dir.join("data").join("notes")
    }

    pub fn create(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
    ) -> Result<PathBuf, CoreError> {
        let now = Local::now();
        let file_path = note_file_path(&self.base_dir, now);
        ensure_dir(&file_path)?;

        let content = format_note_markdown(body, tags, now, context)?;
        fs::write(&file_path, content)?;
        Ok(file_path)
    }

    pub fn list(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let notes_dir = self.notes_dir();
        let entries = list_md_files(&notes_dir)?;

        let summaries = entries
            .into_iter()
            .map(|entry| {
                let path = entry.path();
                let filename = entry.file_name().to_string_lossy().to_string();
                let content = fs::read_to_string(&path).unwrap_or_default();
                NoteSummary::from_file(path, filename, &content)
            })
            .collect();

        Ok(summaries)
    }

    pub fn read(&self, filename: &NoteFilename) -> Result<String, CoreError> {
        let fname = filename.as_str();
        let notes_dir = self.notes_dir();
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

    pub fn update(
        &self,
        path: &Path,
        body: &str,
        tags: &[String],
        context: &Context,
    ) -> Result<(), CoreError> {
        let now = Local::now();
        let content = format_note_markdown(body, tags, now, context)?;
        fs::write(path, content)?;
        Ok(())
    }

    pub fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        let fname = filename.as_str();
        let notes_dir = self.notes_dir();
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
}
