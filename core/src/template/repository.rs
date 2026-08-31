use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::frontmatter;
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::paths::templates_dir;
use crate::utils::validated::NoteFilename;

/// テンプレファイルの frontmatter。ノートのものとは別の型にする。
/// ノート側は `time` を必ず持つが、テンプレに作成時刻の意味はない —
/// 使い回されるのがテンプレで、時刻を持つのはそこから生まれたノートのほう。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct TemplateFrontmatter {
    /// テンプレであることの印。`templates/` に置いてあるだけでは、
    /// このファイルを他の Markdown ツールで開いた人に区別がつかない。
    #[serde(default = "yes")]
    pub template: bool,
    /// ここから作るノートに自動で付くタグ。`{{date:YYYY-MM}}` のような
    /// 変数を書けて、解決されるのはノートを作る瞬間。
    #[serde(default)]
    pub tags: Vec<String>,
}

const fn yes() -> bool {
    true
}

impl Default for TemplateFrontmatter {
    fn default() -> Self {
        Self {
            template: true,
            tags: Vec::new(),
        }
    }
}

/// テンプレ一覧の 1 件。
#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub filename: String,
    /// 拡張子を落とした名前(`daily.md` なら `daily`)。画面に出す名前であり、
    /// ここから作ったノートの frontmatter に刻まれる値でもある。
    pub name: String,
    pub tags: Vec<String>,
    /// 本文の先頭行。変数は解決しない — テンプレの一覧で `{{date}}` が
    /// 今日の日付に化けていると、それが固定文なのか変数なのか分からない。
    pub preview: String,
}

pub(crate) struct Templates {
    base_dir: PathBuf,
}

impl Templates {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn dir(&self) -> PathBuf {
        templates_dir(&self.base_dir)
    }

    fn existing_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        crate::utils::fs::resolve_existing(&self.dir(), filename.as_str())
    }

    /// まだ無いファイルの書き込み先。存在しないものは canonicalize できないので、
    /// 置き場のほうを解決してから名前を繋ぐ。`NoteFilename` が `/` と `..` を
    /// 弾いているので、結果は必ずこのディレクトリの直下になる。
    fn writable_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        let dir = self.dir();
        fs::create_dir_all(&dir)?;
        Ok(fs::canonicalize(&dir)?.join(filename.as_str()))
    }

    pub(crate) fn list(&self) -> Result<Vec<Summary>, CoreError> {
        let mut summaries: Vec<Summary> = list_md_files(&self.dir())?
            .into_iter()
            .map(|entry| {
                let filename = entry.file_name().to_string_lossy().to_string();
                let content = fs::read_to_string(entry.path()).unwrap_or_default();
                summarize(filename, &content)
            })
            .collect();

        // 名前順。テンプレに新旧の意味は無く、探す手がかりは名前しかない
        summaries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(summaries)
    }

    /// frontmatter と本文を分けて返す。本文は所有権つき — 呼ぶ側は必ず
    /// 変数を解決して作り直すので、借りたまま返しても得がない。
    pub(crate) fn read(
        &self,
        filename: &NoteFilename,
    ) -> Result<(TemplateFrontmatter, String), CoreError> {
        let content = fs::read_to_string(self.existing_path(filename)?)?;
        frontmatter::parse::<TemplateFrontmatter>(&content).map_or_else(
            // frontmatter を持たないテンプレは、素の Markdown をそのまま
            // 本文として扱う。テンプレはユーザーが手で置くこともできる
            |_| {
                Ok((
                    TemplateFrontmatter::default(),
                    frontmatter::strip(&content).to_string(),
                ))
            },
            |(fm, body)| Ok((fm, body.to_string())),
        )
    }

    pub(crate) fn save(
        &self,
        filename: &NoteFilename,
        body: &str,
        tags: &[String],
    ) -> Result<(), CoreError> {
        let path = self.writable_path(filename)?;
        ensure_dir(&path)?;
        let fm = TemplateFrontmatter {
            template: true,
            tags: tags.to_vec(),
        };
        write_atomic(&path, frontmatter::render(&fm, body)?)?;
        Ok(())
    }

    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        fs::remove_file(self.existing_path(filename)?)?;
        Ok(())
    }
}

fn summarize(filename: String, content: &str) -> Summary {
    let (tags, body) = frontmatter::parse::<TemplateFrontmatter>(content).map_or_else(
        // 壊れた frontmatter を本文扱いすると、一覧のプレビューに YAML が出る
        |_| (Vec::new(), frontmatter::strip(content)),
        |(fm, body)| (fm.tags, body),
    );

    let name = filename
        .strip_suffix(".md")
        .unwrap_or(&filename)
        .to_string();
    // 見出し記号は落とす。一覧に出したいのは題であって Markdown ではない
    let preview = body
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
        .to_string();

    Summary {
        filename,
        name,
        tags,
        preview,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn templates(tmp: &TempDir) -> Templates {
        Templates::new(tmp.path().to_path_buf())
    }

    fn name(s: &str) -> NoteFilename {
        NoteFilename::parse(s).unwrap()
    }

    #[test]
    fn saving_then_reading_round_trips_the_body_and_tags() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);

        t.save(
            &name("daily.md"),
            "# Daily {{date}}\n\n## メモ",
            &["daily".to_string()],
        )
        .unwrap();

        let (fm, body) = t.read(&name("daily.md")).unwrap();
        assert_eq!(fm.tags, vec!["daily"]);
        assert!(fm.template);
        assert_eq!(body, "# Daily {{date}}\n\n## メモ");
    }

    /// テンプレは `data/` の中に置く。同期の走査が data 配下を辿るので、
    /// ここを外すと他の端末にテンプレが届かない。
    #[test]
    fn templates_are_written_inside_the_data_directory() {
        let tmp = TempDir::new().unwrap();

        templates(&tmp)
            .save(&name("daily.md"), "body", &[])
            .unwrap();

        assert!(tmp.path().join("data/templates/daily.md").exists());
    }

    /// 変数はテンプレの中では文字列のまま。保存で解決してしまうと
    /// 2 回目以降そのテンプレは固定の日付を吐き続ける。
    #[test]
    fn saving_does_not_resolve_variables() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);

        t.save(
            &name("daily.md"),
            "# {{date}}",
            &["{{date:YYYY-MM}}".to_string()],
        )
        .unwrap();

        let raw = fs::read_to_string(tmp.path().join("data/templates/daily.md")).unwrap();
        assert!(raw.contains("{{date}}"));
        assert!(raw.contains("{{date:YYYY-MM}}"));
    }

    #[test]
    fn the_list_is_sorted_by_name() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(&name("weekly.md"), "# 週次", &[]).unwrap();
        t.save(&name("daily.md"), "# 日次", &[]).unwrap();

        let names: Vec<String> = t.list().unwrap().into_iter().map(|s| s.name).collect();

        assert_eq!(names, vec!["daily", "weekly"]);
    }

    #[test]
    fn a_summary_carries_the_tags_and_the_first_line() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(
            &name("daily.md"),
            "# Daily {{date}}\n\n本文",
            &["daily".to_string()],
        )
        .unwrap();

        let listed = t.list().unwrap();

        assert_eq!(listed[0].filename, "daily.md");
        assert_eq!(listed[0].tags, vec!["daily"]);
        // 見出し記号は落とし、変数は残す
        assert_eq!(listed[0].preview, "Daily {{date}}");
    }

    /// テンプレは手で置ける。frontmatter が無いファイルも素の Markdown として読む。
    #[test]
    fn a_file_without_frontmatter_is_still_a_template() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/templates");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plain.md"), "# 手で置いたテンプレ").unwrap();

        let (fm, body) = templates(&tmp).read(&name("plain.md")).unwrap();

        assert!(fm.tags.is_empty());
        assert_eq!(body, "# 手で置いたテンプレ");
    }

    #[test]
    fn deleting_removes_the_file() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(&name("daily.md"), "body", &[]).unwrap();

        t.delete(&name("daily.md")).unwrap();

        assert!(!tmp.path().join("data/templates/daily.md").exists());
        assert!(t.list().unwrap().is_empty());
    }

    #[test]
    fn reading_a_missing_template_is_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/templates")).unwrap();

        let result = templates(&tmp).read(&name("nope.md"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// 名前の検証だけでは、リンク越しに置き場の外を読ませられる。
    #[test]
    fn a_symlink_out_of_the_directory_is_refused() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/templates");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tmp.path().join("outside.md"), "secret").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside.md"), dir.join("linked.md")).unwrap();

        let result = templates(&tmp).read(&name("linked.md"));

        assert!(matches!(result, Err(CoreError::PathTraversal(_))));
    }

    #[test]
    fn an_empty_directory_lists_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(templates(&tmp).list().unwrap().is_empty());
    }
}
