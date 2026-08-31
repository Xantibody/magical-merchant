//! What the home screen widgets read.
//!
//! Split in two along what each caller pays for, not along what is convenient:
//! the capture sheet wants today's tags and reads one day file, while the notes
//! list reads every note. Folding them into one call would make opening the
//! sheet — the thing that has to feel instant — wait on the whole notes tree.
//!
//! Kotlin never parses a timeline line. The `- [HH:MM:SS] text {json}` shape is
//! taken apart here with the same core helpers the app uses, so a change to the
//! format cannot leave the widget rendering a stray JSON tail.

use std::path::Path;

use chrono::Local;
use magical_merchant_core::utils::markdown::{strip_timeline_prefix, timeline_entry_time};
use magical_merchant_core::utils::tags;
use serde::Serialize;

/// 4x2 のノートウィジェットに収まる行数。
const NOTE_LIMIT: usize = 4;
/// テンプレウィジェットのボタン数。押せる高さ(46dp)で並べるとこれが上限。
const TEMPLATE_LIMIT: usize = 3;
/// シートに出すタグチップ。3 つを超えると 1 行に収まらない。
const TAG_LIMIT: usize = 3;
/// バーは 1 行しか出せない。長い記録は先頭だけ見せる。
const PREVIEW_CHARS: usize = 60;
const UNTITLED: &str = "(空のメモ)";

/// キャプチャバーとシートが要るぶん。今日の日ファイル 1 枚で足りる。
#[derive(Debug, Default, Serialize)]
pub(crate) struct CaptureData {
    /// 今日の最後の記録。まだ何も書いていなければ `None`。
    last: Option<LastEntry>,
    /// 今日よく使ったタグ。多い順、同数なら先に出たほう。
    tags: Vec<String>,
}

/// ノート一覧ウィジェットが要るぶん。全ノートを読む。
#[derive(Debug, Default, Serialize)]
pub(crate) struct NotesData {
    /// 新しい順のノート。
    notes: Vec<NoteRow>,
}

/// テンプレウィジェットが要るぶん。テンプレ置き場だけを読む。
#[derive(Debug, Default, Serialize)]
pub(crate) struct TemplatesData {
    /// 名前順のテンプレ。並びが実行ごとに変わると、同じ位置を押しても
    /// 違うノートが生まれる。
    templates: Vec<TemplateRow>,
}

#[derive(Debug, Serialize)]
struct LastEntry {
    time: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct NoteRow {
    title: String,
    filename: String,
    date: String,
}

#[derive(Debug, Serialize)]
struct TemplateRow {
    /// ボタンに出す名前であり、ディープリンクに載せる値でもある。
    name: String,
}

/// Unreadable trees come back empty rather than as an error: a widget with no
/// data still has to draw something, and "not opened yet" is a normal state.
pub(crate) fn collect_capture(base_dir: &Path) -> CaptureData {
    let today = magical_merchant_core::read_timeline(base_dir, Local::now().date_naive())
        .unwrap_or_default();

    CaptureData {
        last: last_entry(&today),
        tags: top_tags(&today),
    }
}

pub(crate) fn collect_notes(base_dir: &Path) -> NotesData {
    NotesData {
        notes: recent_notes(magical_merchant_core::list_notes(base_dir).unwrap_or_default()),
    }
}

/// ノート一覧と分けてあるのは、テンプレ置き場だけ読めば足りるため。
/// ここで全ノートを読むと、ボタンを 3 つ描くために全ファイルを開くことになる。
pub(crate) fn collect_templates(base_dir: &Path) -> TemplatesData {
    TemplatesData {
        templates: magical_merchant_core::list_templates(base_dir)
            .unwrap_or_default()
            .into_iter()
            .take(TEMPLATE_LIMIT)
            .map(|template| TemplateRow {
                name: template.name,
            })
            .collect(),
    }
}

/// 行は追記順なので、最後の 1 行がいちばん新しい。
fn last_entry(entries: &[String]) -> Option<LastEntry> {
    let raw = entries.last()?;
    let text = strip_timeline_prefix(raw);
    Some(LastEntry {
        // 秒はバーの幅を食うだけで、いつ書いたかは分かる。
        time: timeline_entry_time(raw)
            .map(|t| t[..5].to_string())
            .unwrap_or_default(),
        text: truncate(text, PREVIEW_CHARS),
    })
}

fn top_tags(entries: &[String]) -> Vec<String> {
    // 出現順を保ったまま数える。同数のタグが実行ごとに入れ替わると、
    // 同じ画面を開いただけでチップの並びが変わって見える。
    let mut counts: Vec<(String, usize)> = Vec::new();
    for tag in entries
        .iter()
        .flat_map(|entry| tags::parse(strip_timeline_prefix(entry)))
    {
        match counts.iter_mut().find(|(name, _)| *name == tag) {
            Some((_, count)) => *count += 1,
            None => counts.push((tag, 1)),
        }
    }

    counts.sort_by(|a, b| b.1.cmp(&a.1));
    counts
        .into_iter()
        .take(TAG_LIMIT)
        // `#` 込みで返す: チップは押すと本文にそのまま挿す文字列でもあるので、
        // 表示側で足すと挿入側と二重管理になる。
        .map(|(tag, _)| format!("#{tag}"))
        .collect()
}

fn recent_notes(mut notes: Vec<magical_merchant_core::NoteSummary>) -> Vec<NoteRow> {
    // 時刻を持たないノートは frontmatter が壊れているぶんで、順番の手がかりが
    // 無い。落とさず末尾に送る。
    notes.sort_by(|a, b| b.time.cmp(&a.time));
    notes
        .into_iter()
        .take(NOTE_LIMIT)
        .map(|note| NoteRow {
            title: title_of(&note.preview),
            filename: note.filename,
            date: note
                .time
                .map(|t| t.format("%m/%d").to_string())
                .unwrap_or_default(),
        })
        .collect()
}

/// 本文の最初の中身がある行。アプリのノート一覧と同じ見出しにする。
fn title_of(preview: &str) -> String {
    let line = preview
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim();

    if line.is_empty() {
        UNTITLED.to_string()
    } else {
        truncate(line, PREVIEW_CHARS)
    }
}

/// 改行はバーでもリストでも 1 行に潰れるので、空白に均してから切る。
fn truncate(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    flat.chars().take(limit).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_line_is_the_newest_entry() {
        let entries = vec![
            "- [09:00:00] first".to_string(),
            "- [14:30:45] second {\"battery\":80}".to_string(),
        ];
        let last = last_entry(&entries).unwrap();
        assert_eq!(last.time, "14:30");
        assert_eq!(last.text, "second");
    }

    #[test]
    fn an_empty_day_has_no_last_entry() {
        assert!(last_entry(&[]).is_none());
    }

    /// 時刻の無い旧い行でも本文だけは出す。
    #[test]
    fn an_entry_without_a_time_still_shows_its_text() {
        let last = last_entry(&["- plain".to_string()]).unwrap();
        assert_eq!(last.time, "");
        assert_eq!(last.text, "- plain");
    }

    #[test]
    fn tags_come_back_most_used_first() {
        let entries = vec![
            "- [09:00:00] #work started".to_string(),
            "- [10:00:00] #rust and #work".to_string(),
        ];
        assert_eq!(top_tags(&entries), vec!["#work", "#rust"]);
    }

    #[test]
    fn a_day_without_tags_has_no_chips() {
        assert!(top_tags(&["- [09:00:00] plain".to_string()]).is_empty());
    }

    #[test]
    fn a_long_entry_is_cut_with_an_ellipsis() {
        let long = "a".repeat(PREVIEW_CHARS + 10);
        let last = last_entry(&[format!("- [09:00:00] {long}")]).unwrap();
        assert_eq!(last.text.chars().count(), PREVIEW_CHARS + 1);
        assert!(last.text.ends_with('…'));
    }

    #[test]
    fn a_heading_becomes_the_note_title() {
        assert_eq!(title_of("# Hello\nbody"), "Hello");
    }

    #[test]
    fn a_blank_note_is_labelled_rather_than_left_empty() {
        assert_eq!(title_of("\n  \n"), UNTITLED);
    }

    /// 置いた数だけ並べると、ボタンがウィジェットの外まで伸びる。
    #[test]
    fn only_the_first_few_templates_fit_on_the_widget() {
        let tmp = tempfile::TempDir::new().unwrap();
        for name in ["a", "b", "c", "d"] {
            let filename =
                magical_merchant_core::NoteFilename::parse(&format!("{name}.md")).unwrap();
            magical_merchant_core::save_template(tmp.path(), &filename, "body", &[]).unwrap();
        }

        let data = collect_templates(tmp.path());

        assert_eq!(data.templates.len(), TEMPLATE_LIMIT);
        // 名前順。並びが変わると、同じ位置を押しても違うノートが生まれる
        let names: Vec<&str> = data.templates.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c"]);
    }

    /// テンプレを 1 つも置いていない端末が普通の状態。空で描かせる。
    #[test]
    fn a_tree_without_templates_comes_back_empty() {
        let tmp = tempfile::TempDir::new().unwrap();

        assert!(collect_templates(tmp.path()).templates.is_empty());
    }
}
