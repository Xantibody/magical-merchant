use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::markdown::format_note_markdown;
use crate::utils::validated::NoteFilename;

use super::kind::NoteKind;
use super::revision::Revision;
use super::summary::Summary as NoteSummary;

pub(crate) struct Notes {
    base_dir: PathBuf,
}

impl Notes {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// 今この場でノートを 1 本作る。時刻は `create_at` に渡すだけ。
    pub(crate) fn create(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        self.create_at(Local::now().fixed_offset(), body, tags, context, provenance)
    }

    /// 今この場で Codex を 1 本作る。置き場が違うだけで、名前も frontmatter も
    /// ノートと同じ。
    pub(crate) fn create_codex(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        self.create_kind_at(
            NoteKind::Codex,
            Local::now().fixed_offset(),
            body,
            tags,
            context,
            provenance,
        )
    }

    /// 作成時刻を渡してノートを 1 本作る。返るのは書いたファイルのパス。
    ///
    /// ファイル名は秒までの時刻で、それがそのままノートの ID になる
    /// (形式は不変)。同じ秒に 2 本作られたときは空いている秒まで
    /// 1 秒ずつ進める — 名前を変えるのではなく、まだ誰も使っていない
    /// 名前を選び直すだけ。frontmatter の `time` も進めたあとの時刻に
    /// 揃える。名前(一覧の並び)と `time`(表示)がずれると、同じ一覧の
    /// 中で並びと日時が食い違う。渡された時刻が過去でも同じで、移して
    /// きた記録は元の時刻で並び、同じ秒のぶんも 1 本も落ちない。
    ///
    /// 予約は `create_new` に任せる。`exists()` で見てから書くと、その
    /// あいだに別スレッド・別プロセスが同じ名前を取れてしまう。
    /// 作成は `write_atomic`(tmp → rename)を通さない: rename は既存の
    /// ファイルを黙って置き換えるので、衝突回避と両立しない。ここで
    /// 書き途中に落ちても失うのは書きかけの新規ノートだけで、
    /// 既存の記録は壊れない。
    pub(crate) fn create_at(
        &self,
        time: DateTime<FixedOffset>,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        self.create_kind_at(NoteKind::Note, time, body, tags, context, provenance)
    }

    /// ID は種別をまたいで 1 つの名前空間。もう片方の置き場に同じ名前が
    /// あれば、それも「埋まっている秒」として 1 秒進める。こちらは
    /// `exists()` で見るので隙間はあるが、2 つの置き場・2 つのプロセス・
    /// 同じ秒が重なったときだけで、その実害は `relocate_duplicate_ids` が拾う。
    fn create_kind_at(
        &self,
        kind: NoteKind,
        time: DateTime<FixedOffset>,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        let mut time = time;
        let mut file_path = kind.file_path(&self.base_dir, time);
        ensure_dir(&file_path)?;

        loop {
            if kind.other().file_path(&self.base_dir, time).exists() {
                time += chrono::Duration::seconds(1);
                file_path = kind.file_path(&self.base_dir, time);
                continue;
            }
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file_path)
            {
                Ok(mut file) => {
                    let markdown = format_note_markdown(body, tags, time, context, provenance)?;
                    file.write_all(markdown.as_bytes())?;
                    return Ok(file_path);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    time += chrono::Duration::seconds(1);
                    file_path = kind.file_path(&self.base_dir, time);
                }
                Err(e) => return Err(e.into()),
            }
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let mut summaries = Vec::new();
        self.scan(|summary, _| summaries.push(summary))?;
        Ok(summaries)
    }

    /// 全ノートを 1 回ずつ読み、要約と frontmatter を剥がした本文を `visit` に
    /// 渡す。全ノートの本文を見る経路(検索・バックリンク)が `list` の後に
    /// 1 本ずつ読み直すと、ノート 1 件につき open(2) が 2 回になる。macOS では
    /// open が経路全体の 6 割を占めるので、要約を作るために読んだ内容をそのまま
    /// 渡す。
    ///
    /// 本文は 1 本ずつ貸すだけで、全ノートぶんを同時には持たない。要約と本文の
    /// 組を Vec で返すと、大きな保管庫では山の使用量が本文の合計になる。
    ///
    /// 読めなかったノートは `list` と同じく空の要約と空の本文になる。
    ///
    /// 両方の置き場を 1 つの一覧に混ぜ、ファイル名(作成時刻)の新しい順に
    /// 並べる。面ごとの絞り込みは呼ぶ側が `kind` で行う。
    pub(crate) fn scan(&self, mut visit: impl FnMut(NoteSummary, &str)) -> Result<(), CoreError> {
        let mut entries: Vec<(NoteKind, fs::DirEntry)> = Vec::new();
        for kind in [NoteKind::Note, NoteKind::Codex] {
            for entry in list_md_files(&kind.dir(&self.base_dir))? {
                entries.push((kind, entry));
            }
        }
        entries.sort_by_cached_key(|(_, e)| std::cmp::Reverse(e.file_name()));

        for (kind, entry) in entries {
            let path = entry.path();
            let filename = entry.file_name().to_string_lossy().to_string();
            let content = fs::read_to_string(&path).unwrap_or_default();
            let summary = NoteSummary::from_file(kind, path, filename, &content);
            visit(summary, frontmatter::strip(&content));
        }
        Ok(())
    }

    /// ID だけでノートを探す。見つかった置き場が種別。Codex を先に見るのは、
    /// 昇格直後に同期が古い `notes/` 側を戻してきても Codex のほうを
    /// 開くため — 版を刻んでいる側が本物で、戻ってきたほうは
    /// `relocate_duplicate_ids` が片付ける。
    pub(crate) fn locate(&self, filename: &NoteFilename) -> Result<(NoteKind, PathBuf), CoreError> {
        for kind in [NoteKind::Codex, NoteKind::Note] {
            match crate::utils::fs::resolve_existing(&kind.dir(&self.base_dir), filename.as_str()) {
                Ok(path) => return Ok((kind, path)),
                Err(CoreError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Err(CoreError::NotFound(
            NoteKind::Note
                .dir(&self.base_dir)
                .join(filename.as_str())
                .to_string_lossy()
                .to_string(),
        ))
    }

    fn existing_note_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        Ok(self.locate(filename)?.1)
    }

    /// ノートを Codex の置き場へ移す。ID(ファイル名)も中身も変えない —
    /// 同じファイルシステム内の rename なので原子的で、読みかけの相手が
    /// 途中の状態を見ることはない。すでに Codex なら何もしない。
    pub(crate) fn promote_to_codex(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        let (kind, path) = self.locate(filename)?;
        if kind == NoteKind::Codex {
            return Ok(());
        }
        let target = NoteKind::Codex.dir(&self.base_dir).join(filename.as_str());
        ensure_dir(&target)?;
        fs::rename(path, target)?;
        Ok(())
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
        time: DateTime<FixedOffset>,
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

    /// Codex は版のディレクトリ(`codex/<stem>/`)ごと消す。本体だけ消すと、
    /// 誰のものでもない版が同期で配られ続ける。
    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        let (kind, path) = self.locate(filename)?;
        fs::remove_file(path)?;
        if kind == NoteKind::Codex {
            let versions = NoteKind::Codex
                .dir(&self.base_dir)
                .join(filename.as_str().trim_end_matches(".md"));
            if versions.is_dir() {
                fs::remove_dir_all(versions)?;
            }
        }
        Ok(())
    }
}
