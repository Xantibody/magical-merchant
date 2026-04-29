use std::fs::{self, DirEntry};
use std::path::Path;

use crate::error::CoreError;

pub fn ensure_dir(path: &Path) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

pub fn list_md_files(dir: &Path) -> Result<Vec<DirEntry>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    Ok(entries)
}

pub fn count_md_files(dir: &Path) -> Result<usize, CoreError> {
    if !dir.exists() {
        return Ok(0);
    }

    Ok(fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        .count())
}
