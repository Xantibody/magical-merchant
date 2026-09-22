use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::list_scrawl_dates;
use crate::note::{NoteKind, Notes};
use crate::scrawl::Scrawl;
use crate::scrawl::day::DayLog;
use crate::utils::markdown::strip_scrawl_prefix;
use crate::utils::tags;
use crate::utils::text::lowercase;

/// Which store a search hit came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HitKind {
    Scrawl,
    Note,
    Codex,
}

impl From<NoteKind> for HitKind {
    fn from(kind: NoteKind) -> Self {
        match kind {
            NoteKind::Note => Self::Note,
            NoteKind::Codex => Self::Codex,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SearchHit {
    pub kind: HitKind,
    /// The one line shown in the list: the first line of the entry text for Scrawl, of the
    /// body for a Note.
    pub title: String,
    /// An excerpt with context around the hit.
    pub snippet: String,
    /// `YYYY-MM-DD`.
    pub date: String,
    /// The filename for opening a Note. `None` for Scrawl.
    pub filename: Option<String>,
    /// The position of the entry within its day. `None` for a Note.
    pub index: Option<usize>,
    pub tags: Vec<String>,
    /// Where the query starts matching inside `snippet` (in characters, ellipsis included).
    /// `None` when it matched only outside the body, such as a tag.
    pub match_start: Option<usize>,
    /// The matched length (in characters). Used as a pair with `match_start`.
    pub match_len: Option<usize>,
}

const SNIPPET_CONTEXT: usize = 40;
const MAX_HITS: usize = 100;

/// The tags that scope the search (already `tags::normalize`d). Empty means no scoping.
/// With several, only records carrying all of them remain.
///
/// Both sides keep the spelling as typed, so the comparison ignores case.
/// This lets a scope chosen by pressing a chip hit `#CognitiveBias` in a body.
fn in_scope(scope: &[String], own: &[String]) -> bool {
    scope
        .iter()
        .all(|wanted| own.iter().any(|tag| tags::same_tag(tag, wanted)))
}

/// Scan every Scrawl day and collect the entries that match needle (already lowercased)
/// and carry every tag in `scope`. With an empty needle the text filters nothing out.
fn scrawl_hits(
    base_dir: &Path,
    needle: &str,
    scope: &[String],
) -> Result<Vec<SearchHit>, CoreError> {
    let mut hits = Vec::new();
    let scrawl = Scrawl::new(base_dir.to_path_buf());
    // Only a needle spanning a newline cannot use the per-day cutoff. In a CRLF file the
    // newlines inside an entry are normalized to "\n", so it is not a substring of the file.
    // With an empty needle the cutoff always passes, so the lowercasing would be wasted.
    let day_filter_applies = !needle.is_empty() && !needle.contains('\n');

    for date in list_scrawl_dates(base_dir)? {
        let Some(content) = scrawl.read_raw(date)? else {
            continue;
        };
        // An entry's text is a substring of its day file, so if the whole file lacks it, no
        // entry has it. Splitting and the context JSON check can be skipped entirely.
        if day_filter_applies && !lowercase(&content).contains(needle) {
            continue;
        }

        let formatted = date.format("%Y-%m-%d").to_string();
        // Count entries, not raw lines. A day file may carry device info at its head, and
        // counting lines would put index out of step with the caller's ordering.
        for (index, entry) in DayLog::parse(&content)
            .into_entries()
            .into_iter()
            .enumerate()
        {
            let text = strip_scrawl_prefix(&entry);
            let lowered = lowercase(text);
            if !lowered.contains(needle) {
                continue;
            }
            let entry_tags = tags::parse(text);
            if !in_scope(scope, &entry_tags) {
                continue;
            }
            let excerpt = snippet(text, &lowered, needle);
            hits.push(SearchHit {
                kind: HitKind::Scrawl,
                title: first_line(text).to_string(),
                snippet: excerpt.text,
                date: formatted.clone(),
                filename: None,
                index: Some(index),
                tags: entry_tags,
                match_start: excerpt.match_start,
                match_len: excerpt.match_start.map(|_| needle.chars().count()),
            });
        }
    }
    Ok(hits)
}

/// Search across Scrawl and Notes by case-insensitive substring match.
/// Returns newest first.
///
/// Notes are read in full, as in `find_backlinks`. There is no index.
///
/// `tags` is the scope. Only records carrying every given tag are candidates (a leading `#`
/// and ASCII case are ignored). With an empty query but tags present, every record with
/// those tags is returned: the state of having narrowed by a tag on screen becomes the
/// entry to search as it is. With both empty, nothing is returned.
pub fn search_all(
    base_dir: &Path,
    query: &str,
    tags: &[String],
) -> Result<Vec<SearchHit>, CoreError> {
    let needle = lowercase(query.trim());
    let scope: Vec<String> = tags
        .iter()
        .map(|t| tags::normalize(t))
        .filter(|t| !t.is_empty())
        .collect();
    if needle.is_empty() && scope.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits = scrawl_hits(base_dir, &needle, &scope)?;

    let mut tag_haystack = String::new();
    // The full text, not the list's preview (first 100 characters). The longer a note, the
    // less of its later part could be found. The body has the frontmatter stripped, so the
    // `time:` and `tags:` lines are never hit.
    // An unreadable note comes with an empty body, matches neither the needle nor a tag,
    // and just stays out of the results: one note must not fail the whole search
    Notes::new(base_dir.to_path_buf()).scan(|note, body| {
        if !in_scope(&scope, &note.tags) {
            return;
        }
        let lowered = lowercase(body);
        if !lowered.contains(&needle) {
            // Not in the body, so try the tags. format! + join would allocate twice more
            // per note, so one String is reused
            tag_haystack.clear();
            for tag in &note.tags {
                tag_haystack.push(' ');
                tag_haystack.push_str(tag);
            }
            if !lowercase(&tag_haystack).contains(&needle) {
                return;
            }
        }
        let excerpt = snippet(body, &lowered, &needle);
        hits.push(SearchHit {
            kind: note.kind.into(),
            title: first_line(&note.preview).to_string(),
            snippet: excerpt.text,
            date: note
                .time
                .map(|t| t.format("%Y-%m-%d").to_string())
                .unwrap_or_default(),
            filename: Some(note.filename),
            index: None,
            tags: note.tags,
            match_start: excerpt.match_start,
            match_len: excerpt.match_start.map(|_| needle.chars().count()),
        });
    })?;

    hits.sort_by(|a, b| b.date.cmp(&a.date));
    hits.truncate(MAX_HITS);
    Ok(hits)
}

/// Return every Scrawl entry and every Note / Codex note as one sequence, newest first.
///
/// Since it does not narrow by text, it differs from [`search_all`] in three ways. The
/// snippet is the first 40 characters of the body rather than the match position,
/// `match_start` / `match_len` are always `None` (there is no notion of a match), and
/// **the count is not capped**: the Browse screen counts per kind / tag / period from the
/// list returned here, so a cap would make the chip numbers lie.
///
/// The scan costs the same as calling `search_all` with no query (every Scrawl day plus
/// every note's body). Call it only once, when the screen opens.
pub fn browse_all(base_dir: &Path) -> Result<Vec<SearchHit>, CoreError> {
    // A scan with no needle and no scope is a "let everything through" scan. It uses the
    // same entry as search
    let mut hits = scrawl_hits(base_dir, "", &[])?;

    // An unreadable note comes with an empty body (`scan`). Its title and snippet become
    // an empty row, but one note must not fail the whole list: same policy as `search_all`
    Notes::new(base_dir.to_path_buf()).scan(|note, body| {
        hits.push(SearchHit {
            kind: note.kind.into(),
            title: first_line(&note.preview).to_string(),
            snippet: head(body),
            date: note
                .time
                .map(|t| t.format("%Y-%m-%d").to_string())
                .unwrap_or_default(),
            filename: Some(note.filename),
            index: None,
            tags: note.tags,
            match_start: None,
            match_len: None,
        });
    })?;

    hits.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(hits)
}

/// Cut the head of the body as the excerpt. It is [`snippet`] with an empty needle; nothing
/// is matched, so no lowercased copy is needed (`lowered` is used only to find the match).
fn head(text: &str) -> String {
    snippet(text, text, "").text
}

/// Collect the records (notes, Scrawl) that mention `target` with `[[ID]]`.
///
/// There is no index; it is derived by a scan each time it is opened. Notes are read in
/// full, not the list's preview (first 100 characters): a link can be written anywhere
/// in the body.
pub fn find_backlinks(
    base_dir: &Path,
    target: &crate::utils::validated::NoteFilename,
) -> Result<Vec<SearchHit>, CoreError> {
    let stem = target.as_str().trim_end_matches(".md");
    // The closing brackets are not included. `[[ID]]` and `[[ID|display text]]` are the
    // same single link, and a backlink must not vanish over the way it is written
    let needle = format!("[[{stem}");

    let mut hits = scrawl_hits(base_dir, &needle, &[])?;

    // An unreadable note comes with an empty body and just drops out of the backlinks.
    // Better than showing a list that cannot be opened
    Notes::new(base_dir.to_path_buf()).scan(|note, body| {
        if note.filename == target.as_str() || !body.contains(&needle) {
            return;
        }
        let lowered = lowercase(body);
        let excerpt = snippet(body, &lowered, &needle);
        hits.push(SearchHit {
            kind: note.kind.into(),
            title: first_line(&note.preview).to_string(),
            snippet: excerpt.text,
            date: note
                .time
                .map(|t| t.format("%Y-%m-%d").to_string())
                .unwrap_or_default(),
            filename: Some(note.filename),
            index: None,
            tags: note.tags,
            match_start: excerpt.match_start,
            match_len: excerpt.match_start.map(|_| needle.chars().count()),
        });
    })?;

    for hit in &mut hits {
        extend_match_to_link_end(hit);
    }
    hits.sort_by(|a, b| b.date.cmp(&a.date));
    hits.truncate(MAX_HITS);
    Ok(hits)
}

/// Extend the excerpt's highlight to the end of the link's stored form.
///
/// The needle used for matching ends at `[[ID`, so as it is `|display text]]` would stay
/// in the body-text color and one could not tell where the link ends.
fn extend_match_to_link_end(hit: &mut SearchHit) {
    let (Some(start), Some(len)) = (hit.match_start, hit.match_len) else {
        return;
    };
    let chars: Vec<char> = hit.snippet.chars().collect();
    let mut at = start + len;
    while at + 1 < chars.len() {
        // Do not extend if the excerpt is cut off midway or another link starts
        if chars[at] == '\n' || chars[at] == '[' {
            return;
        }
        if chars[at] == ']' && chars[at + 1] == ']' {
            hit.match_len = Some(at + 2 - start);
            return;
        }
        at += 1;
    }
}

/// The one line shown in the list. A note's title is the `# heading` at the head of the
/// body, so the marker is dropped (the list pane's rows show the same shape).
///
/// Only a `#` followed by whitespace is dropped. A Scrawl entry can start with a `#tag`,
/// and cutting that too would lose the category from the title.
fn first_line(text: &str) -> &str {
    let line = text.lines().next().unwrap_or("").trim();
    let rest = line.trim_start_matches('#');
    if rest.len() == line.len() || !rest.starts_with([' ', '\t']) {
        return line;
    }
    rest.trim_start()
}

/// The cut excerpt and where the query starts matching inside it (in characters).
struct Excerpt {
    text: String,
    /// `None` when there is no match in the body (only a tag was hit).
    match_start: Option<usize>,
}

/// Cut `SNIPPET_CONTEXT` characters on each side of the hit without breaking a character
/// boundary. `lowered` is the lowercased `text` used for matching. It is taken rather than
/// rebuilt because this runs once per hit.
fn snippet(text: &str, lowered: &str, needle: &str) -> Excerpt {
    // If the hit was outside the body (a note's tag, for instance), cut from the head.
    // The same with an empty needle (a list narrowed by tag only): there is nothing to highlight.
    let found = if needle.is_empty() {
        None
    } else {
        lowered
            .find(needle)
            .map(|byte| lowered[..byte].chars().count())
    };
    let at = found.unwrap_or(0);
    let end = at + needle.chars().count() + SNIPPET_CONTEXT;
    let start = at.saturating_sub(SNIPPET_CONTEXT);

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    // The leading ellipsis is one character too. Left out of the position, the highlight
    // is off by one character
    let match_start = found.map(|at| at - start + usize::from(start > 0));
    // Walk once instead of building three Vec<char>.
    let mut chars = text.chars().skip(start);
    for _ in start..end {
        match chars.next() {
            Some('\n') => out.push(' '),
            Some(c) => out.push(c),
            None => {
                return Excerpt {
                    text: out,
                    match_start,
                };
            }
        }
    }
    if chars.next().is_some() {
        out.push('…');
    }
    Excerpt {
        text: out,
        match_start,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::{Context, Source};
    use crate::utils::frontmatter::Provenance;
    use crate::{create_draft_codex, create_draft_note, save_scrawl_entry};
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    /// A plain note for search to hit. Provenance is not searched, so none is declared.
    fn draft(tmp: &TempDir, body: &str, tags: &[String]) -> Result<std::path::PathBuf, CoreError> {
        create_draft_note(tmp.path(), body, tags, &context(), Provenance::default())
    }

    /// A hit in a Codex says it is a Codex. It opens on a different surface.
    #[test]
    fn a_hit_in_a_codex_says_so() {
        let tmp = TempDir::new().unwrap();
        create_draft_codex(
            tmp.path(),
            "育てる文書",
            &[],
            &context(),
            Provenance::default(),
        )
        .unwrap();

        let hits = search_all(tmp.path(), "育てる", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Codex);
    }

    /// The list pane shows the title with `# ` dropped. If only the palette and backlinks
    /// kept the marker, the same note would go by a different name on each screen.
    #[test]
    fn a_note_title_drops_the_heading_marker() {
        assert_eq!(first_line("# 設計メモ\n本文"), "設計メモ");
        assert_eq!(first_line("## 小見出し"), "小見出し");
    }

    /// An entry can start with a `#tag`. That is not a heading's `# `.
    #[test]
    fn an_entry_that_starts_with_a_tag_keeps_it() {
        assert_eq!(first_line("#sync を直す"), "#sync を直す");
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "anything", &context(), Source::App).unwrap();

        assert!(search_all(tmp.path(), "   ", &[]).unwrap().is_empty());
    }

    #[test]
    fn finds_a_scrawl_entry_by_substring() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "R2 同期のリトライ戦略", &context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "牛乳を買う", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Scrawl);
        assert_eq!(hits[0].title, "R2 同期のリトライ戦略");
        assert_eq!(hits[0].index, Some(0));
    }

    /// A note hit reported its tags, but an entry hit alone came back empty. The caller
    /// reads them trusting "the same shape", so one side must not stay silent.
    #[test]
    fn a_scrawl_hit_reports_the_tags_in_its_text() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "R2 を直す #Sync #設計", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "直す", &[]).unwrap();

        assert_eq!(hits[0].tags, vec!["Sync", "設計"]);
    }

    #[test]
    fn matching_ignores_case() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "Local-First Sync", &context(), Source::App).unwrap();

        assert_eq!(search_all(tmp.path(), "local-first", &[]).unwrap().len(), 1);
    }

    /// Even on a day whose file carries device info at its head, the returned index must
    /// be the entry's position in order. If this is off, opening a search result shows a
    /// different entry.
    #[test]
    fn an_index_counts_entries_not_lines_of_the_day_file() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context {
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        };
        save_scrawl_entry(tmp.path(), "first", &ctx, Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "second", &ctx, Source::App).unwrap();

        let hits = search_all(tmp.path(), "second", &[]).unwrap();

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
        save_scrawl_entry(tmp.path(), "plain text", &ctx, Source::App).unwrap();

        assert!(search_all(tmp.path(), "MacBook", &[]).unwrap().is_empty());
    }

    #[test]
    fn the_context_json_is_not_searchable() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context {
            battery: Some(82),
            ..Context::default()
        };
        save_scrawl_entry(tmp.path(), "plain text", &ctx, Source::App).unwrap();

        assert!(search_all(tmp.path(), "battery", &[]).unwrap().is_empty());
    }

    #[test]
    fn finds_a_note_by_body_and_reports_its_filename() {
        let tmp = TempDir::new().unwrap();
        let path = draft(&tmp, "R2 のリトライ設計", &[]).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
        // It is the name used to open the note, so it must be exactly the created file's name
        assert_eq!(
            hits[0].filename.as_deref(),
            path.file_name().and_then(|n| n.to_str())
        );
        assert_eq!(hits[0].index, None);
    }

    /// The list's preview is only the first 100 characters. The longer a note, the less of
    /// its later part could be found: unless search reads the whole body, records get lost.
    #[test]
    fn a_needle_deep_in_a_long_note_is_found() {
        let tmp = TempDir::new().unwrap();
        // Put the needle nowhere in the title, the tags or the first 100 characters
        let body = format!(
            "# 長いノート\n{}\n後半にだけリトライと書いた",
            "あ".repeat(300)
        );
        draft(&tmp, &body, &["memo".to_string()]).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert_eq!(hits[0].title, "長いノート");
        assert!(hits[0].snippet.contains("リトライ"), "{}", hits[0].snippet);
        // The UI paints the highlight at this position. Unless it points inside the excerpt,
        // other characters light up
        let start = hits[0].match_start.unwrap();
        let len = hits[0].match_len.unwrap();
        let matched: String = hits[0].snippet.chars().skip(start).take(len).collect();
        assert_eq!(matched, "リトライ");
    }

    /// Even now that the whole body is read, only the body is exposed. Hitting `tags:` or
    /// `time:` in the frontmatter would surface a note for a word never written in it.
    #[test]
    fn the_frontmatter_is_not_searchable() {
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "本文", &["sync".to_string()]).unwrap();

        assert!(search_all(tmp.path(), "time", &[]).unwrap().is_empty());
        assert!(search_all(tmp.path(), "tags", &[]).unwrap().is_empty());
    }

    /// Write one line on a fixed date. `save_scrawl_entry` can only write to today.
    fn write_day(tmp: &TempDir, date: chrono::NaiveDate, text: &str) {
        let dir = tmp.path().join("data/scrawl");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{}.md", date.format("%Y-%m-%d"))),
            format!("- [09:00:00] {text}\n"),
        )
        .unwrap();
    }

    /// Up to 100 are returned, newest first. The older ones are dropped because what one
    /// looks for is usually something written recently.
    #[test]
    fn hits_are_capped_at_the_newest_hundred() {
        let tmp = TempDir::new().unwrap();
        let oldest = chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        for offset in 0..=100 {
            let date = oldest + chrono::Duration::days(offset);
            write_day(&tmp, date, &format!("needle {offset}"));
        }

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits.len(), MAX_HITS);
        assert_eq!(hits[0].date, "2025-04-11");
        assert_eq!(hits[MAX_HITS - 1].date, "2025-01-02");
        assert!(hits.iter().all(|h| h.date != "2025-01-01"));
    }

    #[test]
    fn finds_a_note_by_tag() {
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "body", &["sync".to_string()]).unwrap();

        let hits = search_all(tmp.path(), "sync", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tags, vec!["sync"]);
    }

    #[test]
    fn a_snippet_is_elided_around_the_match() {
        let tmp = TempDir::new().unwrap();
        let long = format!("{}NEEDLE{}", "a".repeat(80), "b".repeat(80));
        save_scrawl_entry(tmp.path(), &long, &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert!(hits[0].snippet.starts_with('…'));
        assert!(hits[0].snippet.ends_with('…'));
        assert!(hits[0].snippet.contains("NEEDLE"));
    }

    #[test]
    fn finds_a_needle_on_a_later_line_of_a_multiline_entry() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(
            tmp.path(),
            "一行目\n二行目にリトライ",
            &context(),
            Source::App,
        )
        .unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "一行目");
        assert!(hits[0].snippet.contains("二行目にリトライ"));
    }

    #[test]
    fn a_tag_only_hit_shows_the_start_of_the_body() {
        let tmp = TempDir::new().unwrap();
        let body = "本文はタグと無関係で長い".repeat(10);
        draft(&tmp, &body, &["sync".to_string()]).unwrap();

        let hits = search_all(tmp.path(), "sync", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.starts_with("本文はタグと無関係で長い"));
        assert!(!hits[0].snippet.starts_with('…'));
    }

    #[test]
    fn a_snippet_keeps_the_body_on_one_line() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "needle のあと\n改行", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits[0].snippet, "needle のあと 改行");
    }

    /// Exactly 40 characters on each side fit whole; elision starts at the 41st.
    /// Counted in characters: counted in bytes, Japanese would be cut at 13 characters.
    #[test]
    fn a_snippet_elides_only_beyond_forty_chars_of_context() {
        let tmp = TempDir::new().unwrap();
        let exact = format!("{}リトライ{}", "前".repeat(40), "後".repeat(40));
        let over = format!("{}リトライ{}", "前".repeat(41), "後".repeat(41));
        draft(&tmp, &exact, &[]).unwrap();
        draft(&tmp, &over, &[]).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        let exact_hit = hits.iter().find(|h| h.snippet == exact).unwrap();
        assert_eq!(exact_hit.match_start, Some(40));
        let over_hit = hits.iter().find(|h| h.snippet != exact).unwrap();
        assert_eq!(
            over_hit.snippet,
            format!("…{}リトライ{}…", "前".repeat(40), "後".repeat(40))
        );
        assert_eq!(over_hit.match_start, Some(41));
    }

    #[test]
    fn a_short_entry_is_not_elided() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "short needle here", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits[0].snippet, "short needle here");
    }

    /// Where in the excerpt the match sits. The UI paints the highlight at this position,
    /// so if it is off, unrelated characters light up.
    #[test]
    fn a_hit_reports_where_the_match_sits_in_the_snippet() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "short needle here", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits[0].match_start, Some(6));
        assert_eq!(hits[0].match_len, Some(6));
    }

    /// An excerpt elided at the front starts with one ellipsis character. Unless the
    /// position counts it, the highlight is off by one character.
    #[test]
    fn an_elided_snippet_counts_the_leading_ellipsis() {
        let tmp = TempDir::new().unwrap();
        let long = format!("{}NEEDLE{}", "a".repeat(80), "b".repeat(80));
        save_scrawl_entry(tmp.path(), &long, &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        let start = hits[0].match_start.unwrap();
        let len = hits[0].match_len.unwrap();
        let matched: String = hits[0].snippet.chars().skip(start).take(len).collect();
        assert_eq!(matched, "NEEDLE");
    }

    /// The position is counted in characters even for multibyte text. Returned in bytes,
    /// it would always be off in a Japanese body.
    #[test]
    fn a_match_position_counts_chars_not_bytes() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(
            tmp.path(),
            "日本語の本文にリトライ",
            &context(),
            Source::App,
        )
        .unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits[0].match_start, Some(7));
        assert_eq!(hits[0].match_len, Some(4));
    }

    /// When only a tag matched, there is nothing in the body to highlight.
    #[test]
    fn a_tag_only_hit_has_no_match_position() {
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "本文", &["sync".to_string()]).unwrap();

        let hits = search_all(tmp.path(), "sync", &[]).unwrap();

        assert_eq!(hits[0].match_start, None);
        assert_eq!(hits[0].match_len, None);
    }

    fn scope(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|t| (*t).to_string()).collect()
    }

    /// The scope is cut by tag, so that one can search while still narrowed by a tag
    /// chosen on screen.
    #[test]
    fn a_tag_scope_keeps_only_entries_carrying_the_tag() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "リトライを直す #sync", &context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "リトライを試す #run", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &scope(&["sync"])).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "リトライを直す #sync");
    }

    #[test]
    fn a_tag_scope_keeps_only_notes_carrying_the_tag() {
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "リトライ設計", &["sync".to_string()]).unwrap();
        draft(&tmp, "リトライの雑記 #misc", &[]).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &scope(&["sync"])).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert_eq!(hits[0].tags, vec!["sync"]);
    }

    /// Passing only a tag with nothing typed lists the records carrying that tag.
    /// This lets the palette show "narrowed by tag" as it is.
    #[test]
    fn an_empty_query_with_a_tag_lists_everything_carrying_it() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "走った #run", &context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "読んだ #book", &context(), Source::App).unwrap();
        draft(&tmp, "走る計画", &["run".to_string()]).unwrap();

        let hits = search_all(tmp.path(), "", &scope(&["run"])).unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.kind == HitKind::Scrawl));
        assert!(hits.iter().any(|h| h.kind == HitKind::Note));
        // There is nothing in the body to highlight
        assert!(hits.iter().all(|h| h.match_start.is_none()));
    }

    /// The list's chips show the spelling as typed, but the typist does not match case.
    /// Whether the scope or the record is the one in capitals, the result is the same.
    #[test]
    fn a_tag_scope_ignores_case_on_both_sides() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(
            tmp.path(),
            "歪みを疑う #CognitiveBias",
            &context(),
            Source::App,
        )
        .unwrap();
        draft(&tmp, "偏りの記録 #cognitivebias", &[]).unwrap();

        let hits = search_all(tmp.path(), "", &scope(&["cognitivebias"])).unwrap();
        assert_eq!(hits.len(), 2);
        // Returned with the spelling as typed
        assert!(hits.iter().any(|h| h.tags == vec!["CognitiveBias"]));

        assert_eq!(
            search_all(tmp.path(), "", &scope(&["#CognitiveBias"]))
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn an_unknown_tag_matches_nothing() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "走った #run", &context(), Source::App).unwrap();

        assert!(
            search_all(tmp.path(), "", &scope(&["nope"]))
                .unwrap()
                .is_empty()
        );
    }

    /// The chosen chip may be `#Sync` while what is written is `#sync`. Writers also tend
    /// to add a leading `#`, so with it the tag is read as the same one.
    #[test]
    fn tag_scope_matching_ignores_case_and_a_leading_hash() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "直す #sync", &context(), Source::App).unwrap();

        assert_eq!(
            search_all(tmp.path(), "", &scope(&["#SYNC"]))
                .unwrap()
                .len(),
            1
        );
    }

    /// Several tags mean AND. If any one would do, query them one at a time.
    #[test]
    fn every_tag_in_the_scope_must_be_present() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "両方 #a #b", &context(), Source::App).unwrap();
        save_scrawl_entry(tmp.path(), "片方 #a", &context(), Source::App).unwrap();

        let hits = search_all(tmp.path(), "", &scope(&["a", "b"])).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "両方 #a #b");
    }

    /// An empty tag does not narrow the scope. If passing `""` wiped every result, the
    /// caller could not tell what happened.
    #[test]
    fn blank_tags_do_not_narrow_the_scope() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "走った #run", &context(), Source::App).unwrap();

        assert_eq!(
            search_all(tmp.path(), "走った", &scope(&["", "#"]))
                .unwrap()
                .len(),
            1
        );
        assert!(
            search_all(tmp.path(), "", &scope(&[""]))
                .unwrap()
                .is_empty()
        );
    }

    fn filename_of(path: &Path) -> crate::utils::validated::NoteFilename {
        crate::utils::validated::NoteFilename::parse(path.file_name().unwrap().to_str().unwrap())
            .unwrap()
    }

    fn stem_of(path: &Path) -> String {
        path.file_stem().unwrap().to_str().unwrap().to_string()
    }

    #[test]
    fn a_scrawl_entry_that_links_a_note_is_a_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "指される側", &[]).unwrap();
        let link = format!("これ参照 [[{}]]", stem_of(&target));
        save_scrawl_entry(tmp.path(), &link, &context(), Source::App).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Scrawl);
        assert!(hits[0].snippet.contains("これ参照"));
    }

    /// The list's preview is only the first 100 characters. A link can be written anywhere
    /// in the body, so without reading the whole text a deep link is missed.
    #[test]
    fn a_link_deep_in_a_long_note_is_still_found() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "指される側", &[]).unwrap();
        let body = format!("{}\n[[{}]]", "あ".repeat(300), stem_of(&target));
        draft(&tmp, &body, &[]).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
    }

    /// A note that links to itself in its own body is not "a record that links to it".
    #[test]
    fn a_note_is_not_its_own_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "後で本文に自分を書く", &[]).unwrap();
        let stem = stem_of(&target);
        crate::update_note(&target, &format!("自分 [[{stem}]]"), &context(), None).unwrap();

        assert!(
            find_backlinks(tmp.path(), &filename_of(&target))
                .unwrap()
                .is_empty()
        );
    }

    /// A link with display text is the same single link. If a backlink vanished over the
    /// way it is written, only the references embedded naturally in prose would go unseen.
    #[test]
    fn a_link_with_display_text_is_a_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "指される側", &[]).unwrap();
        let body = format!("詳しくは [[{}|前の話]] を見る", stem_of(&target));
        draft(&tmp, &body, &[]).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        // The highlight runs to the end of the stored form. If `|前の話]]` stayed in the
        // body-text color, one could not tell where the link ends
        let start = hits[0].match_start.unwrap();
        let len = hits[0].match_len.unwrap();
        let matched: String = hits[0].snippet.chars().skip(start).take(len).collect();
        assert!(matched.ends_with("|前の話]]"), "matched: {matched}");
    }

    #[test]
    fn no_links_means_no_backlinks() {
        let tmp = TempDir::new().unwrap();
        let target = draft(&tmp, "誰も指していない", &[]).unwrap();
        draft(&tmp, "無関係なノート", &[]).unwrap();
        save_scrawl_entry(tmp.path(), "無関係なエントリ", &context(), Source::App).unwrap();

        assert!(
            find_backlinks(tmp.path(), &filename_of(&target))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn browsing_an_empty_tree_returns_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(browse_all(tmp.path()).unwrap().is_empty());
    }

    /// The Browse screen lists everything even with no filter chosen. Entries and notes
    /// mix into one sequence, newest first.
    #[test]
    fn browsing_lists_scrawl_entries_and_notes_newest_first() {
        let tmp = TempDir::new().unwrap();
        write_day(
            &tmp,
            chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(),
            "古い記録",
        );
        draft(&tmp, "今日のノート", &[]).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert_eq!(hits[0].title, "今日のノート");
        assert_eq!(hits[1].kind, HitKind::Scrawl);
        assert_eq!(hits[1].title, "古い記録");
        assert_eq!(hits[1].index, Some(0));
    }

    /// A Codex says it is a Codex, because it opens on a different surface.
    #[test]
    fn a_browsed_codex_says_so() {
        let tmp = TempDir::new().unwrap();
        create_draft_codex(
            tmp.path(),
            "育てる文書",
            &[],
            &context(),
            Provenance::default(),
        )
        .unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Codex);
    }

    /// The chips show tags with counts. They cannot be counted if the source drops the tags.
    #[test]
    fn browsing_carries_the_tags_of_each_record() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "走った #run", &context(), Source::App).unwrap();
        draft(&tmp, "走る計画", &["Plan".to_string()]).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        let entry = hits.iter().find(|h| h.kind == HitKind::Scrawl).unwrap();
        assert_eq!(entry.tags, vec!["run"]);
        let note = hits.iter().find(|h| h.kind == HitKind::Note).unwrap();
        assert_eq!(note.tags, vec!["Plan"]);
    }

    /// The snippet is the first 40 characters of the body. The same number as the search
    /// snippet, and anything beyond gets an ellipsis in the same manner.
    #[test]
    fn a_browsed_snippet_is_the_first_forty_chars_of_the_body() {
        let snippet_of = |len: usize| {
            let tmp = TempDir::new().unwrap();
            draft(&tmp, &"あ".repeat(len), &[]).unwrap();
            browse_all(tmp.path()).unwrap().remove(0).snippet
        };

        assert_eq!(snippet_of(40), "あ".repeat(40));
        assert_eq!(snippet_of(41), format!("{}…", "あ".repeat(40)));
    }

    /// There is no notion of a match, so there is nothing to highlight either.
    #[test]
    fn a_browsed_hit_has_no_match_position() {
        let tmp = TempDir::new().unwrap();
        save_scrawl_entry(tmp.path(), "なんでもよい", &context(), Source::App).unwrap();
        draft(&tmp, "ノートも", &[]).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().all(|h| h.match_start.is_none()));
        assert!(hits.iter().all(|h| h.match_len.is_none()));
    }

    /// One unreadable note does not fail the whole scan (same policy as `search_all`).
    /// Its body comes empty, so the title and snippet are empty, but it stays in the count:
    /// what is counted is the files in the tree, and an empty body cannot filter them out.
    #[test]
    fn an_unreadable_note_does_not_fail_the_browse() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        draft(&tmp, "読めるノート", &[]).unwrap();
        let locked = draft(&tmp, "読めないノート", &[]).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.title == "読めるノート"));
    }

    /// The Browse screen counts from this list. Reusing the 100-hit cap of `search_all`
    /// would make the counts lie from the 101st record on.
    #[test]
    fn browsing_is_not_capped() {
        let tmp = TempDir::new().unwrap();
        let oldest = chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap();
        for offset in 0..=MAX_HITS {
            let date = oldest + chrono::Duration::days(i64::try_from(offset).unwrap());
            write_day(&tmp, date, &format!("記録 {offset}"));
        }

        let hits = browse_all(tmp.path()).unwrap();

        assert_eq!(hits.len(), MAX_HITS + 1);
        assert_eq!(hits[MAX_HITS].date, "2025-01-01");
    }
}
