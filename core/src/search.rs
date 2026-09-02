use std::path::Path;

use serde::Serialize;

use crate::error::CoreError;
use crate::timeline::Timeline;
use crate::timeline::day::DayLog;
use crate::utils::markdown::strip_timeline_prefix;
use crate::utils::tags;
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
    /// `snippet` 内でクエリが一致し始める位置(文字数、省略記号込み)。
    /// タグなど本文の外だけに一致したときは `None`。
    pub match_start: Option<usize>,
    /// 一致した長さ(文字数)。`match_start` と対で使う。
    pub match_len: Option<usize>,
}

const SNIPPET_CONTEXT: usize = 40;
const MAX_HITS: usize = 100;

/// 検索の範囲を切るタグ(`tags::normalize` 済み)。空なら切らない。
/// 複数あれば全部を持つ記録だけが残る。
fn in_scope(scope: &[String], tags: &[String]) -> bool {
    scope.iter().all(|wanted| tags.contains(wanted))
}

/// タイムライン全日を走査して needle(小文字化済み)に一致し、`scope` の
/// タグを全て持つエントリを集める。needle が空なら本文は見ない。
fn timeline_hits(
    base_dir: &Path,
    needle: &str,
    scope: &[String],
) -> Result<Vec<SearchHit>, CoreError> {
    let mut hits = Vec::new();
    let timeline = Timeline::new(base_dir.to_path_buf());
    // 改行をまたぐ needle だけは日単位の足切りが使えない。CRLF のファイルでは
    // エントリ内の改行が "\n" に正規化され、ファイル本文の部分文字列にならない。
    // needle が空なら足切りは常に通るので、小文字化のぶんだけ無駄になる。
    let day_filter_applies = !needle.is_empty() && !needle.contains('\n');

    for date in list_timeline_dates(base_dir)? {
        let Some(content) = timeline.read_raw(date)? else {
            continue;
        };
        // エントリ本文はその日のファイルの部分文字列なので、ファイル全体に無いなら
        // どのエントリにも無い。分割もコンテキスト JSON の判定も丸ごと省ける。
        if day_filter_applies && !content.to_lowercase().contains(needle) {
            continue;
        }

        let formatted = date.format("%Y-%m-%d").to_string();
        // 生の行ではなくエントリを数える。日ファイルの先頭には端末情報が載って
        // いることがあり、行で数えると index が呼び出し側の並びとずれる。
        for (index, entry) in DayLog::parse(&content)
            .into_entries()
            .into_iter()
            .enumerate()
        {
            let text = strip_timeline_prefix(&entry);
            let lowered = text.to_lowercase();
            if !lowered.contains(needle) {
                continue;
            }
            let entry_tags = tags::parse(text);
            if !in_scope(scope, &entry_tags) {
                continue;
            }
            let excerpt = snippet(text, &lowered, needle);
            hits.push(SearchHit {
                kind: HitKind::Timeline,
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

/// Timeline と Notes を横断して大文字小文字を無視した部分一致で検索する。
/// 新しいものから順に返す。
///
/// `tags` は範囲。渡された全てのタグを持つ記録だけが対象になる(`#` の有無と
/// ASCII の大小は見ない)。query が空でも tags があれば、そのタグの付いた記録を
/// 全部返す — 画面でタグを選んで絞った状態を、そのまま検索の入り口にするため。
/// どちらも空なら何も返さない。
pub fn search_all(
    base_dir: &Path,
    query: &str,
    tags: &[String],
) -> Result<Vec<SearchHit>, CoreError> {
    let needle = query.trim().to_lowercase();
    let scope: Vec<String> = tags
        .iter()
        .map(|t| tags::normalize(t))
        .filter(|t| !t.is_empty())
        .collect();
    if needle.is_empty() && scope.is_empty() {
        return Ok(Vec::new());
    }

    let mut hits = timeline_hits(base_dir, &needle, &scope)?;

    let mut haystack = String::new();
    for note in list_notes(base_dir)? {
        if !in_scope(&scope, &note.tags) {
            continue;
        }
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
        let excerpt = snippet(&note.preview, &lowered, &needle);
        hits.push(SearchHit {
            kind: HitKind::Note,
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
    }

    hits.sort_by(|a, b| b.date.cmp(&a.date));
    hits.truncate(MAX_HITS);
    Ok(hits)
}

/// `target` へ `[[ID]]` で言及している記録(ノート・タイムライン)を集める。
///
/// インデックスは持たず、開かれるたびに走査で導出する。ノートは一覧の
/// preview(先頭 100 文字)ではなく全文を読む — リンクは本文のどこにでも
/// 書かれるため。
pub fn find_backlinks(
    base_dir: &Path,
    target: &crate::utils::validated::NoteFilename,
) -> Result<Vec<SearchHit>, CoreError> {
    let stem = target.as_str().trim_end_matches(".md");
    // 閉じ括弧まで含めない。`[[ID]]` と `[[ID|表示文字]]` は同じ 1 本のリンクで、
    // 書き方の違いでバックリンクが消えてはいけない
    let needle = format!("[[{stem}");

    let mut hits = timeline_hits(base_dir, &needle, &[])?;

    for note in list_notes(base_dir)? {
        if note.filename == target.as_str() {
            continue;
        }
        // 読めないノートはバックリンク欄から消えるだけ。開けない一覧を出すより良い
        let Ok(body) = crate::read_note(&note.path) else {
            continue;
        };
        if !body.contains(&needle) {
            continue;
        }
        let lowered = body.to_lowercase();
        let excerpt = snippet(&body, &lowered, &needle);
        hits.push(SearchHit {
            kind: HitKind::Note,
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
    }

    for hit in &mut hits {
        extend_match_to_link_end(hit);
    }
    hits.sort_by(|a, b| b.date.cmp(&a.date));
    hits.truncate(MAX_HITS);
    Ok(hits)
}

/// 抜粋の強調をリンクの保存形の終わりまで伸ばす。
///
/// 一致に使う needle は `[[ID` までなので、そのままでは `|表示文字]]` が
/// 地の文の色で残り、どこまでがリンクなのか読めない。
fn extend_match_to_link_end(hit: &mut SearchHit) {
    let (Some(start), Some(len)) = (hit.match_start, hit.match_len) else {
        return;
    };
    let chars: Vec<char> = hit.snippet.chars().collect();
    let mut at = start + len;
    while at + 1 < chars.len() {
        // 抜粋が途中で切れている・別のリンクが始まったなら伸ばさない
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

/// 一覧に出す 1 行。ノートの題は本文先頭の `# 見出し` なので記号は落とす
/// (一覧ペインの行も同じ形で出している)。
///
/// 落とすのは後ろに空白のある `#` だけ。タイムラインのエントリは `#タグ`
/// で始まることがあり、そこまで削ると分類が題から消える。
fn first_line(text: &str) -> &str {
    let line = text.lines().next().unwrap_or("").trim();
    let rest = line.trim_start_matches('#');
    if rest.len() == line.len() || !rest.starts_with([' ', '\t']) {
        return line;
    }
    rest.trim_start()
}

/// 切り出した抜粋と、その中でクエリが一致し始める位置(文字数)。
struct Excerpt {
    text: String,
    /// 本文に一致がない(タグだけに当たった)ときは `None`。
    match_start: Option<usize>,
}

/// ヒット位置の前後 `SNIPPET_CONTEXT` 文字を、文字境界を壊さずに切り出す。
/// `lowered` は照合に使った `text` の小文字版。作り直さず受け取るのは、
/// ここが 1 ヒットごとに走るため。
fn snippet(text: &str, lowered: &str, needle: &str) -> Excerpt {
    // ヒットしたのが本文以外(ノートのタグなど)なら先頭から切り出す。
    // needle が空(タグだけで絞った一覧)のときも同じ — 光らせる場所はない。
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
    // 先頭の「…」も 1 文字。位置に入れないとハイライトが 1 文字ずれる
    let match_start = found.map(|at| at - start + usize::from(start > 0));
    // Vec<char> を 3 本作らずに 1 度だけ走査する。
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
    use crate::utils::device::Context;
    use crate::{create_draft_note, save_timeline_entry};
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    /// 一覧ペインは `# ` を落とした題を出す。パレットとバックリンクだけ
    /// 記号付きだと、同じノートが画面ごとに違う名前を名乗る。
    #[test]
    fn a_note_title_drops_the_heading_marker() {
        assert_eq!(first_line("# 設計メモ\n本文"), "設計メモ");
        assert_eq!(first_line("## 小見出し"), "小見出し");
    }

    /// エントリは `#タグ` で始まることがある。見出しの `# ` とは違う。
    #[test]
    fn an_entry_that_starts_with_a_tag_keeps_it() {
        assert_eq!(first_line("#sync を直す"), "#sync を直す");
    }

    #[test]
    fn an_empty_query_matches_nothing() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "anything", &context()).unwrap();

        assert!(search_all(tmp.path(), "   ", &[]).unwrap().is_empty());
    }

    #[test]
    fn finds_a_timeline_entry_by_substring() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "R2 同期のリトライ戦略", &context()).unwrap();
        save_timeline_entry(tmp.path(), "牛乳を買う", &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Timeline);
        assert_eq!(hits[0].title, "R2 同期のリトライ戦略");
        assert_eq!(hits[0].index, Some(0));
    }

    /// ノートのヒットはタグを名乗るのに、エントリのヒットだけ空だった。
    /// 呼び出し側が「同じ形」と信じて読むので、片方だけ黙っていてはいけない。
    #[test]
    fn a_timeline_hit_reports_the_tags_in_its_text() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "R2 を直す #Sync #設計", &context()).unwrap();

        let hits = search_all(tmp.path(), "直す", &[]).unwrap();

        assert_eq!(hits[0].tags, vec!["sync", "設計"]);
    }

    #[test]
    fn matching_ignores_case() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "Local-First Sync", &context()).unwrap();

        assert_eq!(search_all(tmp.path(), "local-first", &[]).unwrap().len(), 1);
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
        save_timeline_entry(tmp.path(), "plain text", &ctx).unwrap();

        assert!(search_all(tmp.path(), "MacBook", &[]).unwrap().is_empty());
    }

    #[test]
    fn the_context_json_is_not_searchable() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context {
            battery: Some(82),
            ..Context::default()
        };
        save_timeline_entry(tmp.path(), "plain text", &ctx).unwrap();

        assert!(search_all(tmp.path(), "battery", &[]).unwrap().is_empty());
    }

    #[test]
    fn finds_a_note_by_body_and_reports_its_filename() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(tmp.path(), "R2 のリトライ設計", &[], &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert!(hits[0].filename.is_some());
    }

    #[test]
    fn finds_a_note_by_tag() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(tmp.path(), "body", &["sync".to_string()], &context()).unwrap();

        let hits = search_all(tmp.path(), "sync", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].tags, vec!["sync"]);
    }

    #[test]
    fn a_snippet_is_elided_around_the_match() {
        let tmp = TempDir::new().unwrap();
        let long = format!("{}NEEDLE{}", "a".repeat(80), "b".repeat(80));
        save_timeline_entry(tmp.path(), &long, &context()).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert!(hits[0].snippet.starts_with('…'));
        assert!(hits[0].snippet.ends_with('…'));
        assert!(hits[0].snippet.contains("NEEDLE"));
    }

    #[test]
    fn finds_a_needle_on_a_later_line_of_a_multiline_entry() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "一行目\n二行目にリトライ", &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "一行目");
        assert!(hits[0].snippet.contains("二行目にリトライ"));
    }

    #[test]
    fn a_tag_only_hit_shows_the_start_of_the_body() {
        let tmp = TempDir::new().unwrap();
        let body = "本文はタグと無関係で長い".repeat(10);
        create_draft_note(tmp.path(), &body, &["sync".to_string()], &context()).unwrap();

        let hits = search_all(tmp.path(), "sync", &[]).unwrap();

        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.starts_with("本文はタグと無関係で長い"));
        assert!(!hits[0].snippet.starts_with('…'));
    }

    #[test]
    fn a_snippet_keeps_the_body_on_one_line() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "needle のあと\n改行", &context()).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits[0].snippet, "needle のあと 改行");
    }

    #[test]
    fn a_short_entry_is_not_elided() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "short needle here", &context()).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits[0].snippet, "short needle here");
    }

    /// 抜粋のどこが一致したか。UI はこの位置でハイライトを塗るので、
    /// ずれると無関係な文字が光る。
    #[test]
    fn a_hit_reports_where_the_match_sits_in_the_snippet() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "short needle here", &context()).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        assert_eq!(hits[0].match_start, Some(6));
        assert_eq!(hits[0].match_len, Some(6));
    }

    /// 前が省略された抜粋では先頭に「…」が 1 文字入る。位置はそれ込みで
    /// 返さないと、ハイライトが 1 文字ずれる。
    #[test]
    fn an_elided_snippet_counts_the_leading_ellipsis() {
        let tmp = TempDir::new().unwrap();
        let long = format!("{}NEEDLE{}", "a".repeat(80), "b".repeat(80));
        save_timeline_entry(tmp.path(), &long, &context()).unwrap();

        let hits = search_all(tmp.path(), "needle", &[]).unwrap();

        let start = hits[0].match_start.unwrap();
        let len = hits[0].match_len.unwrap();
        let matched: String = hits[0].snippet.chars().skip(start).take(len).collect();
        assert_eq!(matched, "NEEDLE");
    }

    /// マルチバイト文字圏でも位置は文字数で数える。バイト数で返すと
    /// 日本語の本文で必ずずれる。
    #[test]
    fn a_match_position_counts_chars_not_bytes() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "日本語の本文にリトライ", &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &[]).unwrap();

        assert_eq!(hits[0].match_start, Some(7));
        assert_eq!(hits[0].match_len, Some(4));
    }

    /// タグだけに一致したときは本文に光らせる場所がない。
    #[test]
    fn a_tag_only_hit_has_no_match_position() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(tmp.path(), "本文", &["sync".to_string()], &context()).unwrap();

        let hits = search_all(tmp.path(), "sync", &[]).unwrap();

        assert_eq!(hits[0].match_start, None);
        assert_eq!(hits[0].match_len, None);
    }

    fn scope(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|t| (*t).to_string()).collect()
    }

    /// 画面でタグを選んで絞り込んだまま検索できるように、範囲はタグで切る。
    #[test]
    fn a_tag_scope_keeps_only_entries_carrying_the_tag() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "リトライを直す #sync", &context()).unwrap();
        save_timeline_entry(tmp.path(), "リトライを試す #run", &context()).unwrap();

        let hits = search_all(tmp.path(), "リトライ", &scope(&["sync"])).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "リトライを直す #sync");
    }

    #[test]
    fn a_tag_scope_keeps_only_notes_carrying_the_tag() {
        let tmp = TempDir::new().unwrap();
        create_draft_note(
            tmp.path(),
            "リトライ設計",
            &["sync".to_string()],
            &context(),
        )
        .unwrap();
        write_second_note(tmp.path(), "20200101_000000.md", "リトライの雑記 #misc");

        let hits = search_all(tmp.path(), "リトライ", &scope(&["sync"])).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
        assert_eq!(hits[0].tags, vec!["sync"]);
    }

    /// 何も打たずにタグだけ渡すと、そのタグの付いた記録が一覧になる。
    /// パレットで「タグで絞った状態」をそのまま眺められるようにするため。
    #[test]
    fn an_empty_query_with_a_tag_lists_everything_carrying_it() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "走った #run", &context()).unwrap();
        save_timeline_entry(tmp.path(), "読んだ #book", &context()).unwrap();
        create_draft_note(tmp.path(), "走る計画", &["run".to_string()], &context()).unwrap();

        let hits = search_all(tmp.path(), "", &scope(&["run"])).unwrap();

        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.kind == HitKind::Timeline));
        assert!(hits.iter().any(|h| h.kind == HitKind::Note));
        // 本文には光らせる場所がない
        assert!(hits.iter().all(|h| h.match_start.is_none()));
    }

    #[test]
    fn an_unknown_tag_matches_nothing() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "走った #run", &context()).unwrap();

        assert!(
            search_all(tmp.path(), "", &scope(&["nope"]))
                .unwrap()
                .is_empty()
        );
    }

    /// 選んだチップは `#Sync` でも、書かれているのは `#sync` かもしれない。
    /// 先頭の `#` も書き手が付けがちなので、付いていても同じタグとして読む。
    #[test]
    fn tag_scope_matching_ignores_case_and_a_leading_hash() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "直す #sync", &context()).unwrap();

        assert_eq!(
            search_all(tmp.path(), "", &scope(&["#SYNC"]))
                .unwrap()
                .len(),
            1
        );
    }

    /// 複数渡したら AND。どれか 1 つで良いなら、1 つずつ引けばいい。
    #[test]
    fn every_tag_in_the_scope_must_be_present() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "両方 #a #b", &context()).unwrap();
        save_timeline_entry(tmp.path(), "片方 #a", &context()).unwrap();

        let hits = search_all(tmp.path(), "", &scope(&["a", "b"])).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "両方 #a #b");
    }

    /// 空のタグは範囲を狭めない。`""` を渡されて全件が消えると、呼び出し側は
    /// 何が起きたか分からない。
    #[test]
    fn blank_tags_do_not_narrow_the_scope() {
        let tmp = TempDir::new().unwrap();
        save_timeline_entry(tmp.path(), "走った #run", &context()).unwrap();

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

    /// 2 件目のノートを固定名で直接書く。`create_draft_note` を同じ秒に
    /// 2 回呼ぶとファイル名が衝突し、1 件目を上書きしてしまう。
    fn write_second_note(base: &Path, filename: &str, body: &str) {
        use crate::utils::frontmatter::{self, NoteFrontmatter};
        use chrono::TimeZone;
        let fm = NoteFrontmatter::new(
            chrono::FixedOffset::east_opt(9 * 3600)
                .unwrap()
                .with_ymd_and_hms(2020, 1, 1, 0, 0, 0)
                .unwrap(),
        );
        let path = crate::utils::paths::notes_dir(base).join(filename);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, frontmatter::render(&fm, body).unwrap()).unwrap();
    }

    #[test]
    fn a_timeline_entry_that_links_a_note_is_a_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = create_draft_note(tmp.path(), "指される側", &[], &context()).unwrap();
        let link = format!("これ参照 [[{}]]", stem_of(&target));
        save_timeline_entry(tmp.path(), &link, &context()).unwrap();

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Timeline);
        assert!(hits[0].snippet.contains("これ参照"));
    }

    /// 一覧の preview は先頭 100 文字しかない。リンクは本文のどこにでも
    /// 書かれるので、全文を読まないと深い位置のリンクを見落とす。
    #[test]
    fn a_link_deep_in_a_long_note_is_still_found() {
        let tmp = TempDir::new().unwrap();
        let target = create_draft_note(tmp.path(), "指される側", &[], &context()).unwrap();
        let body = format!("{}\n[[{}]]", "あ".repeat(300), stem_of(&target));
        write_second_note(tmp.path(), "20200101_000000.md", &body);

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, HitKind::Note);
    }

    /// 自分の中に自分へのリンクを書いても「リンクされている記録」ではない。
    #[test]
    fn a_note_is_not_its_own_backlink() {
        let tmp = TempDir::new().unwrap();
        let target =
            create_draft_note(tmp.path(), "後で本文に自分を書く", &[], &context()).unwrap();
        let stem = stem_of(&target);
        crate::update_note(&target, &format!("自分 [[{stem}]]"), &context()).unwrap();

        assert!(
            find_backlinks(tmp.path(), &filename_of(&target))
                .unwrap()
                .is_empty()
        );
    }

    /// 表示文字を付けたリンクも同じ 1 本のリンク。書き方でバックリンクが
    /// 消えると、文中に自然に埋め込んだ参照だけが見えなくなる。
    #[test]
    fn a_link_with_display_text_is_a_backlink() {
        let tmp = TempDir::new().unwrap();
        let target = create_draft_note(tmp.path(), "指される側", &[], &context()).unwrap();
        let body = format!("詳しくは [[{}|前の話]] を見る", stem_of(&target));
        write_second_note(tmp.path(), "20200101_000000.md", &body);

        let hits = find_backlinks(tmp.path(), &filename_of(&target)).unwrap();

        assert_eq!(hits.len(), 1);
        // 強調は保存形の終わりまで。`|前の話]]` が地の文の色で残ると、
        // どこまでがリンクなのか読めない
        let start = hits[0].match_start.unwrap();
        let len = hits[0].match_len.unwrap();
        let matched: String = hits[0].snippet.chars().skip(start).take(len).collect();
        assert!(matched.ends_with("|前の話]]"), "matched: {matched}");
    }

    #[test]
    fn no_links_means_no_backlinks() {
        let tmp = TempDir::new().unwrap();
        let target = create_draft_note(tmp.path(), "誰も指していない", &[], &context()).unwrap();
        write_second_note(tmp.path(), "20200101_000000.md", "無関係なノート");
        save_timeline_entry(tmp.path(), "無関係なエントリ", &context()).unwrap();

        assert!(
            find_backlinks(tmp.path(), &filename_of(&target))
                .unwrap()
                .is_empty()
        );
    }
}
