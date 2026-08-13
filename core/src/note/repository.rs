use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter};
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::markdown::format_note_markdown;
use crate::utils::paths::{note_file_path, notes_dir};
use crate::utils::validated::NoteFilename;

use super::summary::Summary as NoteSummary;

pub(crate) struct Notes {
    base_dir: PathBuf,
}

impl Notes {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn notes_dir(&self) -> PathBuf {
        notes_dir(&self.base_dir)
    }

    pub(crate) fn create(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
    ) -> Result<PathBuf, CoreError> {
        let now = Local::now();
        let file_path = note_file_path(&self.base_dir, now);
        ensure_dir(&file_path)?;

        let markdown = format_note_markdown(body, tags, now, context)?;
        write_atomic(&file_path, markdown)?;
        Ok(file_path)
    }

    pub(crate) fn list(&self) -> Result<Vec<NoteSummary>, CoreError> {
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

    /// 検証済みのノート名を実ファイルパスに解決する。名前の検証だけでは
    /// シンボリックリンク越しに notes の外へ出られるので、canonicalize した
    /// 実体が notes ディレクトリ配下にあることまで確かめる。
    fn existing_note_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
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
        Ok(canonical_file_path)
    }

    pub(crate) fn read(&self, filename: &NoteFilename) -> Result<String, CoreError> {
        let content = fs::read_to_string(self.existing_note_path(filename)?)?;
        Ok(frontmatter::strip(&content).to_string())
    }

    /// 本文だけを書き換える。frontmatter は作成時の記録なので手を付けない。
    ///
    /// - time: 作成時刻。一覧はファイル名(作成時刻)順に並ぶため、編集で
    ///   動かすと日付グループと並び順が食い違う
    /// - tags: 本文の `#記法` に移行済みだが、タグ欄で付けていた頃のぶんを
    ///   空で上書きすると過去のノートから分類が消える
    /// - context: どの端末で書いたかの記録。編集端末で上書きしない
    ///
    /// frontmatter が読めないファイルだけ、今この場の時刻と端末で作り直す。
    pub(crate) fn update(path: &Path, body: &str, context: &Context) -> Result<(), CoreError> {
        let existing = fs::read_to_string(path).unwrap_or_default();
        let fm = frontmatter::parse::<NoteFrontmatter>(&existing).map_or_else(
            |_| NoteFrontmatter {
                time: Local::now().into(),
                tags: Vec::new(),
                context: Some(context.clone()),
            },
            |(fm, _)| fm,
        );

        let markdown = frontmatter::render(&fm, body)?;
        write_atomic(path, markdown)?;
        Ok(())
    }

    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        fs::remove_file(self.existing_note_path(filename)?)?;
        Ok(())
    }
}
