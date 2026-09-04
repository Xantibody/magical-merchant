use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::Local;

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::markdown::format_note_markdown;
use crate::utils::paths::{note_file_path, notes_dir};
use crate::utils::validated::NoteFilename;

use super::revision::Revision;
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

    /// ノートを 1 本作る。返るのは書いたファイルのパス。
    ///
    /// ファイル名は秒までの時刻で、それがそのままノートの ID になる
    /// (形式は不変)。同じ秒に 2 本作られたときは空いている秒まで
    /// 1 秒ずつ進める — 名前を変えるのではなく、まだ誰も使っていない
    /// 名前を選び直すだけ。frontmatter の `time` も進めたあとの時刻に
    /// 揃える。名前(一覧の並び)と `time`(表示)がずれると、同じ一覧の
    /// 中で並びと日時が食い違う。
    ///
    /// 予約は `create_new` に任せる。`exists()` で見てから書くと、その
    /// あいだに別スレッド・別プロセスが同じ名前を取れてしまう。
    /// 作成は `write_atomic`(tmp → rename)を通さない: rename は既存の
    /// ファイルを黙って置き換えるので、衝突回避と両立しない。ここで
    /// 書き途中に落ちても失うのは書きかけの新規ノートだけで、
    /// 既存の記録は壊れない。
    pub(crate) fn create(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        let mut now = Local::now();
        let mut file_path = note_file_path(&self.base_dir, now);
        ensure_dir(&file_path)?;

        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file_path)
            {
                Ok(mut file) => {
                    let markdown = format_note_markdown(body, tags, now, context, provenance)?;
                    file.write_all(markdown.as_bytes())?;
                    return Ok(file_path);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    now += chrono::Duration::seconds(1);
                    file_path = note_file_path(&self.base_dir, now);
                }
                Err(e) => return Err(e.into()),
            }
        }
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

    fn existing_note_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        crate::utils::fs::resolve_existing(&self.notes_dir(), filename.as_str())
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
    ///
    /// `expected` は読んだときの本文の指紋。今の本文と食い違えば、誰かが
    /// 先に書いている — その上に書くと相手の編集が黙って消える。
    pub(crate) fn update(
        path: &Path,
        body: &str,
        context: &Context,
        expected: Option<&Revision>,
    ) -> Result<Revision, CoreError> {
        let existing = fs::read_to_string(path).unwrap_or_default();
        if let Some(expected) = expected {
            let current = Revision::of(frontmatter::strip(&existing));
            if current != *expected {
                let name = path.file_name().map_or_else(
                    || path.display().to_string(),
                    |n| n.to_string_lossy().to_string(),
                );
                return Err(CoreError::Stale(name));
            }
        }
        let now = Local::now();
        let fm = frontmatter::parse::<NoteFrontmatter>(&existing).map_or_else(
            |_| NoteFrontmatter {
                context: Some(context.clone()),
                ..NoteFrontmatter::new(now.into())
            },
            |(fm, _)| NoteFrontmatter {
                updated: Some(now.into()),
                ..fm
            },
        );

        let markdown = frontmatter::render(&fm, body)?;
        write_atomic(path, markdown)?;
        Ok(Revision::of(body))
    }

    pub(crate) fn read_meta(&self, filename: &NoteFilename) -> Result<NoteFrontmatter, CoreError> {
        let content = fs::read_to_string(self.existing_note_path(filename)?)?;
        let (fm, _body) = frontmatter::parse::<NoteFrontmatter>(&content)?;
        Ok(fm)
    }

    /// frontmatter の一部だけを差し替えて書き戻す。本文には触れない。
    ///
    /// frontmatter が読めないファイルは `update` と違って作り直さない。
    /// 本文の保存は失敗させられないが、メタデータ編集はでっち上げた記録を
    /// 書くくらいなら断ったほうがいい。
    fn edit_frontmatter<F>(&self, filename: &NoteFilename, edit: F) -> Result<(), CoreError>
    where
        F: FnOnce(NoteFrontmatter) -> NoteFrontmatter,
    {
        let path = self.existing_note_path(filename)?;
        let content = fs::read_to_string(&path)?;
        let (existing, body) = frontmatter::parse::<NoteFrontmatter>(&content)?;
        write_atomic(&path, frontmatter::render(&edit(existing), body)?)?;
        Ok(())
    }

    /// time と tags だけを差し替える。context には触れない。
    pub(crate) fn update_meta(
        &self,
        filename: &NoteFilename,
        time: chrono::DateTime<chrono::FixedOffset>,
        tags: &[String],
    ) -> Result<(), CoreError> {
        self.edit_frontmatter(filename, |existing| NoteFrontmatter {
            time,
            tags: tags.to_vec(),
            ..existing
        })
    }

    /// 表示モードだけを差し替える。
    pub(crate) fn update_view(
        &self,
        filename: &NoteFilename,
        view: Option<&str>,
    ) -> Result<(), CoreError> {
        self.edit_frontmatter(filename, |existing| NoteFrontmatter {
            view: view.map(str::to_string),
            ..existing
        })
    }

    /// 昇格元エントリとの繋がりだけを差し替える。
    pub(crate) fn update_origin(
        &self,
        filename: &NoteFilename,
        origin: Option<&str>,
    ) -> Result<(), CoreError> {
        self.edit_frontmatter(filename, |existing| NoteFrontmatter {
            origin: origin.map(str::to_string),
            ..existing
        })
    }

    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        fs::remove_file(self.existing_note_path(filename)?)?;
        Ok(())
    }
}
