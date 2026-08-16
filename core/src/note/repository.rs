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
        origin: Option<&str>,
    ) -> Result<PathBuf, CoreError> {
        let now = Local::now();
        let file_path = note_file_path(&self.base_dir, now);
        ensure_dir(&file_path)?;

        let markdown = format_note_markdown(body, tags, now, context, origin)?;
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
    ///
    /// 唯一ここが書き足すのが `updated`。本文を書き直したのはこの経路だけで、
    /// メタデータや表示モードの差し替えは「書き直し」ではない。
    pub(crate) fn update(path: &Path, body: &str, context: &Context) -> Result<(), CoreError> {
        let existing = fs::read_to_string(path).unwrap_or_default();
        let now = Local::now();
        let fm = frontmatter::parse::<NoteFrontmatter>(&existing).map_or_else(
            |_| NoteFrontmatter {
                time: now.into(),
                tags: Vec::new(),
                context: Some(context.clone()),
                view: None,
                origin: None,
                updated: None,
            },
            |(fm, _)| NoteFrontmatter {
                updated: Some(now.into()),
                ..fm
            },
        );

        let markdown = frontmatter::render(&fm, body)?;
        write_atomic(path, markdown)?;
        Ok(())
    }

    pub(crate) fn read_meta(&self, filename: &NoteFilename) -> Result<NoteFrontmatter, CoreError> {
        let content = fs::read_to_string(self.existing_note_path(filename)?)?;
        let (fm, _body) = frontmatter::parse::<NoteFrontmatter>(&content)?;
        Ok(fm)
    }

    /// time と tags だけを差し替えて書き戻す。本文と context には触れない。
    ///
    /// frontmatter が読めないファイルは `update` と違って作り直さない。
    /// 本文の保存は失敗させられないが、メタデータ編集はでっち上げた記録を
    /// 書くくらいなら断ったほうがいい。
    pub(crate) fn update_meta(
        &self,
        filename: &NoteFilename,
        time: chrono::DateTime<chrono::FixedOffset>,
        tags: &[String],
    ) -> Result<(), CoreError> {
        let path = self.existing_note_path(filename)?;
        let content = fs::read_to_string(&path)?;
        let (existing, body) = frontmatter::parse::<NoteFrontmatter>(&content)?;

        let fm = NoteFrontmatter {
            time,
            tags: tags.to_vec(),
            context: existing.context,
            view: existing.view,
            origin: existing.origin,
            updated: existing.updated,
        };
        write_atomic(&path, frontmatter::render(&fm, body)?)?;
        Ok(())
    }

    /// 表示モードだけを差し替えて書き戻す。他のメタデータと本文には触れない。
    ///
    /// `update_meta` と同じく、frontmatter が読めないファイルには書かない。
    /// 表示の好みのために壊れた記録を正当化するべきではない。
    pub(crate) fn update_view(
        &self,
        filename: &NoteFilename,
        view: Option<&str>,
    ) -> Result<(), CoreError> {
        let path = self.existing_note_path(filename)?;
        let content = fs::read_to_string(&path)?;
        let (existing, body) = frontmatter::parse::<NoteFrontmatter>(&content)?;

        let fm = NoteFrontmatter {
            view: view.map(str::to_string),
            ..existing
        };
        write_atomic(&path, frontmatter::render(&fm, body)?)?;
        Ok(())
    }

    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        fs::remove_file(self.existing_note_path(filename)?)?;
        Ok(())
    }
}
