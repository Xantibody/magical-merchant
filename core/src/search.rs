use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::utils::markdown::strip_timeline_prefix;
use crate::{list_notes, list_timeline_dates, read_timeline};

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

    for date in list_timeline_dates(base_dir)? {
        let formatted = date.format("%Y-%m-%d").to_string();
        for (index, entry) in read_timeline(base_dir, date)?.into_iter().enumerate() {
            let text = strip_timeline_prefix(&entry);
            if !text.to_lowercase().contains(&needle) {
                continue;
            }
            hits.push(SearchHit {
                kind: HitKind::Timeline,
                title: first_line(text).to_string(),
                snippet: snippet(text, &needle),
                date: formatted.clone(),
                filename: None,
                index: Some(index),
                tags: Vec::new(),
            });
        }
    }

    for note in list_notes(base_dir)? {
        let haystack = format!("{} {}", note.preview, note.tags.join(" "));
        if !haystack.to_lowercase().contains(&needle) {
            continue;
        }
        hits.push(SearchHit {
            kind: HitKind::Note,
            title: first_line(&note.preview).to_string(),
            snippet: snippet(&note.preview, &needle),
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
fn snippet(text: &str, needle: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lowered: Vec<char> = text.to_lowercase().chars().collect();
    let needle_chars: Vec<char> = needle.chars().collect();

    let at = lowered
        .windows(needle_chars.len().max(1))
        .position(|w| w == needle_chars.as_slice())
        .unwrap_or(0);

    let start = at.saturating_sub(SNIPPET_CONTEXT);
    let end = (at + needle_chars.len() + SNIPPET_CONTEXT).min(chars.len());

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out.replace('\n', " ")
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
    fn a_short_entry_is_not_elided() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "short needle here", &context()).unwrap();

        let hits = search_all(tmp.path(), "needle").unwrap();

        assert_eq!(hits[0].snippet, "short needle here");
    }
}
