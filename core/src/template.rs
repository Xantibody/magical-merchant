//! ノートのテンプレート。
//!
//! テンプレ自体は `data/templates/*.md` に置く素の Markdown で、ノートと
//! 同じように同期される。特別なのは本文とタグに `{{…}}` を書けることだけで、
//! それが値になるのはここからノートを作る瞬間 — テンプレファイルの中では
//! 最後まで文字列のまま(`vars`)。

mod repository;
mod vars;

pub use repository::Summary as TemplateSummary;
pub use vars::VarLocale;

use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;

use crate::error::CoreError;
use crate::note::{NoteSummary, Notes};
use crate::utils::device::Context;
use crate::utils::frontmatter::Provenance;
use crate::utils::validated::NoteFilename;
use repository::Templates;
use vars::resolve_vars;

/// テンプレ起動の結果。
#[derive(Debug, Clone, Serialize)]
pub struct CreatedNote {
    pub path: PathBuf,
    /// 今日のぶんが既にあったので、作らずにそれを開いた。
    ///
    /// 呼ぶ側にとっては「開く」で同じだが、押しても件数が増えない理由は
    /// 伝わらないと不親切なので、区別できるようにしておく。
    pub reused: bool,
}

pub fn list_templates(base_dir: &Path) -> Result<Vec<TemplateSummary>, CoreError> {
    Templates::new(base_dir.to_path_buf()).list()
}

/// テンプレ 1 件の中身。本文と自動タグは編集画面が同時に描くもので、
/// 別々に読ませればファイルを 2 回開くことになる。
#[derive(Debug, Clone, Serialize)]
pub struct TemplateDetail {
    /// 変数を解決していない、書かれたままの本文。
    pub body: String,
    pub tags: Vec<String>,
}

pub fn read_template(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<TemplateDetail, CoreError> {
    Templates::new(base_dir.to_path_buf())
        .read(filename)
        .map(|(fm, body)| TemplateDetail {
            body,
            tags: fm.tags,
        })
}

/// 無ければ作り、あれば上書きする。テンプレのファイル名は ID ではなく
/// ただの名前なので、ノートと違って作り直しも改名も呼ぶ側の自由。
pub fn save_template(
    base_dir: &Path,
    filename: &NoteFilename,
    body: &str,
    tags: &[String],
) -> Result<(), CoreError> {
    Templates::new(base_dir.to_path_buf()).save(filename, body, tags)
}

pub fn delete_template(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Templates::new(base_dir.to_path_buf()).delete(filename)
}

/// テンプレからノートを作る。
///
/// 同じテンプレの今日のノートが既にあれば作らずにそれを返す。日次テンプレを
/// ウィジェットから 1 日に何度も叩くのは普通のことで、そのたびに空の
/// 「Daily」が増えるとテンプレのほうが邪魔になる。
///
/// `provenance` は呼ぶ側が名乗る出自。テンプレ名だけはここで埋める —
/// ファイル名から導けるものを呼ぶ側に渡させても間違いが増えるだけ。
pub fn create_note_from_template(
    base_dir: &Path,
    filename: &NoteFilename,
    context: &Context,
    locale: VarLocale,
    provenance: Provenance<'_>,
) -> Result<CreatedNote, CoreError> {
    let (fm, body) = Templates::new(base_dir.to_path_buf()).read(filename)?;
    let name = template_name(filename);
    let now = Local::now();
    let notes = crate::note::list_notes(base_dir)?;

    if let Some(existing) = todays_note(&notes, name, now) {
        return Ok(CreatedNote {
            path: existing.path.clone(),
            reused: true,
        });
    }

    let prev = previous_note_link(&notes, name);
    let resolved = resolve_vars(&body, now, prev.as_deref(), locale);
    // タグに `{{prev}}` を書く人はいないが、書かれても行ごと落とす規則が
    // そのまま効いて空文字になる。空のタグはタグではない
    let tags: Vec<String> = fm
        .tags
        .iter()
        .map(|tag| resolve_vars(tag, now, prev.as_deref(), locale))
        .filter(|tag| !tag.trim().is_empty())
        .collect();

    let path = Notes::new(base_dir.to_path_buf()).create(
        &resolved,
        &tags,
        context,
        Provenance {
            template: Some(name),
            ..provenance
        },
    )?;

    Ok(CreatedNote {
        path,
        reused: false,
    })
}

/// frontmatter に刻む名前。拡張子を落としたファイル名そのもの。
fn template_name(filename: &NoteFilename) -> &str {
    let name = filename.as_str();
    name.strip_suffix(".md").unwrap_or(name)
}

fn todays_note<'a>(
    notes: &'a [NoteSummary],
    template: &str,
    now: chrono::DateTime<Local>,
) -> Option<&'a NoteSummary> {
    let today = now.date_naive();
    notes.iter().find(|note| {
        note.template.as_deref() == Some(template)
            && note
                .time
                .is_some_and(|time| time.with_timezone(&Local).date_naive() == today)
    })
}

/// 同じテンプレから最後に作られたノートへの `[[ID]]` リンク。
fn previous_note_link(notes: &[NoteSummary], template: &str) -> Option<String> {
    notes
        .iter()
        .filter(|note| note.template.as_deref() == Some(template))
        .filter_map(|note| note.time.map(|time| (time, &note.filename)))
        .max_by_key(|(time, _)| *time)
        .map(|(_, filename)| format!("[[{}]]", filename.strip_suffix(".md").unwrap_or(filename)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::{list_notes, read_note};
    use crate::utils::frontmatter::{self, NoteFrontmatter};
    use crate::utils::paths::notes_dir;
    use std::fs;
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    fn name(s: &str) -> NoteFilename {
        NoteFilename::parse(s).unwrap()
    }

    fn daily(tmp: &TempDir) {
        save_template(
            tmp.path(),
            &name("daily.md"),
            "# Daily {{date}}\n\n## 今日やること\n\n前回: {{prev}}",
            &["daily".to_string(), "{{date:YYYY-MM}}".to_string()],
        )
        .unwrap();
    }

    /// 過去の日付のノートを直に書く。`{{prev}}` も「今日のぶんはもう在るか」も
    /// 日付で判定するので、`create_note_from_template`(作成時刻は今)では
    /// 昨日以前のノートを用意できない。
    fn seed_note(tmp: &TempDir, filename: &str, template: &str, days_ago: i64) {
        let time = (Local::now() - chrono::Duration::days(days_ago)).fixed_offset();
        let fm = NoteFrontmatter {
            template: Some(template.to_string()),
            ..NoteFrontmatter::new(time)
        };
        let dir = notes_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(filename),
            frontmatter::render(&fm, "既にあるノート").unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn creating_resolves_the_variables_in_the_body() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        let body = read_note(&created.path).unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        assert!(body.contains(&format!("# Daily {today}")));
        assert!(!body.contains("{{"));
        assert!(!created.reused);
    }

    /// 1 本目には前回が無い。「前回: 」だけの行を残さない。
    #[test]
    fn the_first_note_has_no_previous_line() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(!read_note(&created.path).unwrap().contains("前回"));
    }

    #[test]
    fn the_next_note_links_back_to_the_previous_one() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        seed_note(&tmp, "20260830_090000.md", "daily", 1);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(
            read_note(&created.path)
                .unwrap()
                .contains("前回: [[20260830_090000]]")
        );
    }

    /// 前回は「同じテンプレの」直近。別のテンプレのノートは指さない。
    #[test]
    fn the_previous_link_ignores_other_templates() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        seed_note(&tmp, "20260830_090000.md", "weekly", 1);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(!read_note(&created.path).unwrap().contains("前回"));
    }

    #[test]
    fn the_tags_are_resolved_and_recorded() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        let listed = list_notes(tmp.path()).unwrap();
        let month = Local::now().format("%Y-%m").to_string();
        assert!(listed[0].tags.contains(&"daily".to_string()));
        assert!(listed[0].tags.contains(&month));
    }

    /// 出自が残っていないと、次のノートの `{{prev}}` も同日の判定も成り立たない。
    #[test]
    fn the_note_records_which_template_it_came_from() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(
            list_notes(tmp.path()).unwrap()[0].template,
            Some("daily".to_string())
        );
    }

    /// 日次テンプレを 1 日に何度叩いても、その日のノートは 1 本。
    #[test]
    fn the_same_template_reuses_todays_note() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        let first = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        let second = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(second.path, first.path);
        assert!(second.reused);
        assert_eq!(list_notes(tmp.path()).unwrap().len(), 1);
    }

    /// 昨日のぶんは今日のぶんではない。日をまたいだら新しく作る。
    #[test]
    fn yesterdays_note_does_not_stand_in_for_todays() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        seed_note(&tmp, "20260830_090000.md", "daily", 1);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(!created.reused);
        assert_eq!(list_notes(tmp.path()).unwrap().len(), 2);
    }

    /// 曜日だけが言語で変わる。テンプレの中身は同じ。
    #[test]
    fn the_weekday_follows_the_locale_of_the_caller() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("w.md"), "{{weekday}}", &[]).unwrap();

        let created = create_note_from_template(
            tmp.path(),
            &name("w.md"),
            &context(),
            VarLocale::En,
            Provenance::default(),
        )
        .unwrap();

        let body = read_note(&created.path).unwrap();
        assert!(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].contains(&body.trim()));
    }

    #[test]
    fn creating_from_a_missing_template_is_not_found() {
        let tmp = TempDir::new().unwrap();

        let result = create_note_from_template(
            tmp.path(),
            &name("nope.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        );

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
