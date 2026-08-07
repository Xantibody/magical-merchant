use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::timeline::Timeline;
use crate::timeline::day::DayLog;
use crate::utils::markdown::strip_timeline_prefix;
use crate::{list_notes, list_timeline_dates};

/// 検索結果がどちらの保管場所から来たか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HitKind {
    Timeline,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub kind: HitKind,
    /// リストに出す 1 行。Timeline はエントリ本文、Note は先頭行。
    pub title: String,
    /// ヒット箇所の前後を含む抜粋。
    pub snippet: String,
    /// `YYYY-MM-DD`。
    pub date: String,
    /// Note を開くためのファイル名。Timeline では `None`。
    pub filename: Option<String>,
    /// その日の何番目のエントリか。Note では `None`。
    pub index: Option<usize>,
    pub tags: Vec<String>,
}

const SNIPPET_CONTEXT: usize = 40;
const MAX_HITS: usize = 100;

/// Timeline と Notes を横断して大文字小文字を無視した部分一致で検索する。
/// 新しいものから順に返す。
pub fn search_all(base_dir: &Path, query: &str) -> Result<Vec<SearchHit>, CoreError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits = Vec::new();
    let timeline = Timeline::new(base_dir.to_path_buf());
    // 改行をまたぐ needle だけは日単位の足切りが使えない。CRLF のファイルでは
    // エントリ内の改行が "\n" に正規化され、ファイル本文の部分文字列にならない。
    let day_filter_applies = !needle.contains('\n');

    for date in list_timeline_dates(base_dir)? {
        let Some(content) = timeline.read_raw(date)? else {
            continue;
        };
        // エントリ本文はその日のファイルの部分文字列なので、ファイル全体に無いなら
        // どのエントリにも無い。分割もコンテキスト JSON の判定も丸ごと省ける。
        if day_filter_applies && !content.to_lowercase().contains(&needle) {
            continue;
        }

        let formatted = date.format("%Y-%m-%d").to_string();
        // 生の行ではなくエントリを数える。日ファイルの先頭には端末情報が載って
        // いることがあり、行で数えると index が呼び出し側の並びとずれる。
        for (index, entry) in DayLog::parse(&content).into_entries().into_iter().enumerate() {
            let text = strip_timeline_prefix(&entry);
            let lowered = text.to_lowercase();
            if !lowered.contains(&needle) {
                continue;
            }
            hits.push(SearchHit {
                kind: HitKind::Timeline,
                title: first_line(text).to_string(),
                snippet: snippet(text, &lowered, &needle),
                date: formatted.clone(),
                filename: None,
                index: Some(index),
                tags: Vec::new(),
            });
        }
    }

    let mut haystack = String::new();
    for note in list_notes(base_dir)? {
        // format! + join だとノート 1 件につき 2 回余分に確保する。
        haystack.clear();
        haystack.push_str(&note.preview);
        for tag in &note.tags {
            haystack.push(' ');
            haystack.push_str(tag);
        }
        if !haystack.to_lowercase().contains(&needle) {
            continue;
        }
        let lowered = note.preview.to_lowercase();
        hits.push(SearchHit {
            kind: HitKind::Note,
            title: first_line(&note.preview).to_string(),
            snippet: snippet(&note.preview, &lowered, &needle),
            date: note
                .time
                .map(|t| t.format("%Y-%m-%d").to_string())
                .unwrap_or_default(),
            filename: Some(note.filename),
            index: None,
            tags: note.tags,
        });
    }

    hits.sort_by(|a, b| b.date.cmp(&a.date));
    hits.truncate(MAX_HITS);
    Ok(hits)
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or("").trim()
}

/// ヒット位置の前後 `SNIPPET_CONTEXT` 文字を、文字境界を壊さずに切り出す。
/// `lowered` は照合に使った `text` の小文字版。作り直さず受け取るのは、
/// ここが 1 ヒットごとに走るため。
fn snippet(text: &str, lowered: &str, needle: &str) -> String {
    // ヒットしたのが本文以外（ノートのタグなど）なら先頭から切り出す。
    let at = lowered
        .find(needle)
        .map_or(0, |byte| lowered[..byte].chars().count());
    let end = at + needle.chars().count() + SNIPPET_CONTEXT;
    let start = at.saturating_sub(SNIPPET_CONTEXT);

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    // Vec<char> を 3 本作らずに 1 度だけ走査する。
    let mut chars = text.chars().skip(start);
    for _ in start..end {
        match chars.next() {
            Some('\n') => out.push(' '),
            Some(c) => out.push(c),
            None => return out,
        }
    }
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Context;
    use crate::{create_draft_note, save_timeline_entry};
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "anything", &context()).unwrap();

        assert!(search_all(tmp.path(), "   ").unwrap().is_empty());
    }

    #[test]
    fn finds_a_timeline_entry_by_substring() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "R2 同期のリトライ戦略", &context()).unwrap();
        save_timeline_entry(tmp.path(), "牛乳を買う", &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Timeline);
        assert_eq!(hits[0].title, "R2 同期のリトライ戦略");
        assert_eq!(hits[0].index, Some(0));
    }

    #[test]
    fn matching_ignores_case() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "Local-First Sync", &context()).unwrap();

        assert_eq!(search_all(tmp.path(), "local-first").unwrap().len(), 1);
    }

    /// 日ファイルの先頭に端末情報が載っている日でも、返す index は
    /// エントリの並び順でなければならない。ここがずれると検索結果を
    /// 開いたときに別のエントリが出る。
    #[test]
    fn an_index_counts_entries_not_lines_of_the_day_file() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context {
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        save_timeline_entry(tmp.path(), "first", &ctx).unwrap();
        save_timeline_entry(tmp.path(), "second", &ctx).unwrap();

        let hits = search_all(tmp.path(), "second").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "second");
        assert_eq!(hits[0].index, Some(1));
    }

    #[test]
    fn the_device_list_is_not_searchable() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context {
            os: "macos".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        save_timeline_entry(tmp.path(), "plain text", &ctx).unwrap();

        assert!(search_all(tmp.path(), "MacBook").unwrap().is_empty());
    }

    #[test]
    fn the_context_json_is_not_searchable() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context {
            battery: Some(82),
            ..Context::default()
        };
        save_timeline_entry(tmp.path(), "plain text", &ctx).unwrap();

        assert!(search_all(tmp.path(), "battery").unwrap().is_empty());
    }

    #[test]
    fn finds_a_note_by_body_and_reports_its_filename() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(tmp.path(), "R2 のリトライ設計", &[], &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert!(hits[0].filename.is_some());
    }

    #[test]
    fn finds_a_note_by_tag() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(tmp.path(), "body", &["sync".to_string()], &context()).unwrap();

        let hits = search_all(tmp.path(), "sync").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tags, vec!["sync"]);
    }

    #[test]
    fn a_snippet_is_elided_around_the_match() {
        let tmp = TempDir::new().unwrap();
        let long = format!("{}NEEDLE{}", "a".repeat(80), "b".repeat(80));
        save_timeline_entry(tmp.path(), &long, &context()).unwrap();

        let hits = search_all(tmp.path(), "needle").unwrap();

        assert!(hits[0].snippet.starts_with('…'));
        assert!(hits[0].snippet.ends_with('…'));
        assert!(hits[0].snippet.contains("NEEDLE"));
    }

    #[test]
    fn finds_a_needle_on_a_later_line_of_a_multiline_entry() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "一行目\n二行目にリトライ", &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "一行目");
        assert!(hits[0].snippet.contains("二行目にリトライ"));
    }

    #[test]
    fn a_tag_only_hit_shows_the_start_of_the_body() {
        let tmp = TempDir::new().unwrap();
        let body = "本文はタグと無関係で長い".repeat(10);
        create_draft_note(tmp.path(), &body, &["sync".to_string()], &context()).unwrap();

        let hits = search_all(tmp.path(), "sync").unwrap();

        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.starts_with("本文はタグと無関係で長い"));
        assert!(!hits[0].snippet.starts_with('…'));
    }

    #[test]
    fn a_snippet_keeps_the_body_on_one_line() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "needle のあと\n改行", &context()).unwrap();

        let hits = search_all(tmp.path(), "needle").unwrap();

        assert_eq!(hits[0].snippet, "needle のあと 改行");
    }

    #[test]
    fn a_short_entry_is_not_elided() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "short needle here", &context()).unwrap();

        let hits = search_all(tmp.path(), "needle").unwrap();

        assert_eq!(hits[0].snippet, "short needle here");
    }
}
