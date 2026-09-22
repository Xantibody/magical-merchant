//! Picks up `#tag` from the body.
//!
//! Managing tags in a separate field stops the writing hand and turns it into
//! classification work. Written inline in the body, they stay at the pace of writing.
//!
//! The same rules live in `tauri-app/src/lib/tags.ts`. That side has to interpret
//! the body as is on screen (completion and coloring); this side has to read the
//! whole note to build the list. Fix one and fix the other.
//!
//! One deliberate difference: only this side skips code fences and code spans. It
//! reads the full Markdown of a note, while that side reads one Scrawl line (and
//! markdown-it separates the code first).

/// Characters a tag may contain. Checked with `is_alphanumeric` so Japanese tags work.
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// The key that decides tag identity. Used only for matching and counting.
///
/// A difference in case is the same tag to the writer. Only ASCII is lowercased
/// (Japanese has no case, and no locale-dependent conversion is brought in).
/// The same rule lives in `foldTag` in `tauri-app/src/lib/tags.ts`.
#[must_use]
pub fn fold_tag(tag: &str) -> String {
    tag.to_ascii_lowercase()
}

/// Whether two tags are the same. Differences in spelling case are ignored.
///
/// AIDEV-NOTE: Must always answer the same as `fold_tag(a) == fold_tag(b)` (a test enforces it). The side that needs no key avoids the allocation.
#[must_use]
pub const fn same_tag(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Folds spellings that differ only in case into one. In order of appearance; the
/// first one seen is kept.
///
/// This rule alone decides "which spelling represents the tag". Whether picked from
/// the body or coming from the frontmatter, a different answer would show different
/// letters on each screen. `collect_span` drops by the same rule while picking, so
/// that a discarded spelling is never allocated. The same rule lives in `foldUnique`
/// in `tauri-app/src/lib/tags.ts`.
///
/// AIDEV-NOTE: A linear scan, not a keyed Map. A note has a few tags, and not adding allocations is what helps the list load.
fn fold_unique(tags: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut folded: Vec<String> = Vec::new();
    for tag in tags {
        if !folded.iter().any(|seen| same_tag(seen, &tag)) {
            folded.push(tag);
        }
    }
    folded
}

/// Returns the `#tag`s in the body, in order of appearance, without repeats.
///
/// The character before `#` must not be a tag character. This keeps out URL
/// fragments such as `https://example.com#frag` and the `#` of `C#`.
///
/// The rule is not "preceded by whitespace". Japanese puts no space between words,
/// so that would miss perfectly ordinary writing such as `走った。#run`.
///
/// A `# heading` has whitespace right after the `#`, so not one character matches.
///
/// Code is not read. `#include` and `#define` were not typed as tags by the writer,
/// and the preview does not color the inside of code either.
#[must_use]
pub fn parse(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut fence: Option<(char, usize)> = None;

    for line in text.lines() {
        if let Some((marker, len)) = fence {
            // a fence shorter than the opening one does not close it
            if fence_marker(line).is_some_and(|(m, l)| m == marker && l >= len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_marker(line) {
            fence = Some(open);
            continue;
        }
        collect_line(line, &mut tags);
    }

    tags
}

/// Merges the frontmatter tags and the body's `#tag`s into the one list the note claims.
///
/// `#tag` written in the body is the current way of input. What remains in the
/// frontmatter is from the days of the tag field; dropping it would strip old
/// notes of their classification. Spellings that differ only in case fold into one,
/// and the frontmatter spelling is kept, because that is the form the note names
/// itself with. The file content is not touched.
///
/// The frontmatter arrives as written, so `Memo` and `memo` can sit side by side
/// inside it alone. Folding is not only for matching against the body: if the list
/// a note claims shows the same category twice, the counting side reads that one
/// note as two.
#[must_use]
pub fn merge(tags: Vec<String>, body: &str) -> Vec<String> {
    fold_unique(tags.into_iter().chain(parse(body)))
}

/// Brings a tag passed from outside into the form `parse` returns.
///
/// A chip on screen or an MCP argument may come with a `#`, as in `#Sync`. Only
/// the decoration is dropped; the spelling is not touched. Case-insensitive
/// matching is the job of `same_tag`, and folding here would make the typed
/// letters vanish from the caller's view. If it ends up empty it is "not a tag",
/// and the caller must discard it.
#[must_use]
pub fn normalize(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_string()
}

/// If the line is a code fence delimiter, returns its marker and count.
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = trimmed.chars().take_while(|&c| c == marker).count();
    (len >= 3).then_some((marker, len))
}

/// Reads one line, only outside code spans (`` ` ``).
fn collect_line(line: &str, tags: &mut Vec<String>) {
    let mut rest = line;
    while let Some(start) = rest.find('`') {
        collect_span(&rest[..start], tags);
        let after = &rest[start..];
        let ticks = after.chars().take_while(|&c| c == '`').count();
        let (delim, body) = after.split_at(ticks);
        // an unclosed `` ` `` is just a symbol; the rest is read as body
        rest = body.find(delim).map_or(body, |end| &body[end + ticks..]);
    }
    collect_span(rest, tags);
}

/// Picks tags out of one contiguous run of text outside code.
///
/// What is returned is the spelling as typed. Case is ignored only when dropping
/// repeats (`same_tag`), so `#Memo` and `#memo` become one, and the one that
/// appeared first stays.
///
/// Jumps to the next `#` instead of looking at every character. `is_alphanumeric`
/// consults a Unicode table for each Japanese character, so tracing the whole
/// body had become the most expensive step in loading the list. Whether there
/// is a tag is decided by the one character before `#` and the tag characters
/// after it; nothing else needs to be looked at.
fn collect_span(span: &str, tags: &mut Vec<String>) {
    let mut pos = 0;
    while let Some(offset) = span[pos..].find('#') {
        let hash = pos + offset;
        let start = hash + '#'.len_utf8();
        pos = start;

        // a tag character right before means a `#` inside a word; the second one in
        // `#a#b` lands here too
        if span[..hash].chars().next_back().is_some_and(is_tag_char) {
            continue;
        }

        let rest = &span[start..];
        let len = rest
            .char_indices()
            .find(|&(_, c)| !is_tag_char(c))
            .map_or(rest.len(), |(index, _)| index);
        if len == 0 {
            continue;
        }

        let tag = &rest[..len];
        if !tags.iter().any(|seen| same_tag(seen, tag)) {
            tags.push(tag.to_string());
        }
        pos = start + len;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_up_a_tag_written_in_the_body() {
        assert_eq!(parse("R2 の同期を直す #sync"), vec!["sync"]);
    }

    #[test]
    fn picks_up_japanese_tags() {
        assert_eq!(parse("#設計 を見直す"), vec!["設計"]);
    }

    #[test]
    fn keeps_the_order_they_appear_in_and_drops_repeats() {
        assert_eq!(parse("#a と #b と #a"), vec!["a", "b"]);
    }

    #[test]
    fn allows_underscores_and_hyphens() {
        assert_eq!(
            parse("#local-first #note_taking"),
            vec!["local-first", "note_taking"]
        );
    }

    /// A line starting with `# ` is a Markdown heading. Counting it as a tag would
    /// give nearly every note an empty tag.
    #[test]
    fn ignores_a_markdown_heading() {
        assert_eq!(parse("# 見出し\n本文"), Vec::<String>::new());
    }

    /// A URL fragment or a `#` inside a word was not typed as a tag by the writer.
    #[test]
    fn ignores_a_hash_that_is_not_at_a_word_boundary() {
        assert_eq!(parse("https://example.com/a#frag"), Vec::<String>::new());
        assert_eq!(parse("C#"), Vec::<String>::new());
    }

    /// Japanese puts no space between words. If the position right after a full stop
    /// is missed, most tags written as intended are lost.
    #[test]
    fn finds_a_tag_right_after_japanese_punctuation() {
        assert_eq!(parse("走った。#run"), vec!["run"]);
        assert_eq!(parse("バグ、#bug を直す"), vec!["bug"]);
        assert_eq!(parse("(#note)"), vec!["note"]);
    }

    #[test]
    fn finds_a_tag_at_the_very_start() {
        assert_eq!(parse("#朝 に走った"), vec!["朝"]);
    }

    #[test]
    fn finds_a_tag_at_the_start_of_a_later_line() {
        assert_eq!(parse("一行目\n#二行目"), vec!["二行目"]);
    }

    #[test]
    fn stops_a_tag_at_punctuation() {
        assert_eq!(parse("#sync、あとで"), vec!["sync"]);
        assert_eq!(parse("#sync. done"), vec!["sync"]);
    }

    /// A `#` inside code is not a tag the writer typed. The preview does not color
    /// the inside of code either; only the chips in the list were picking it up.
    #[test]
    fn ignores_hashes_inside_a_fenced_code_block() {
        let text = "本文 #real\n\n```c\n#include <stdio.h>\n#define N 1\n```\n\n続き";
        assert_eq!(parse(text), vec!["real"]);
    }

    #[test]
    fn ignores_hashes_inside_an_inline_code_span() {
        assert_eq!(parse("`#define` は展開される #memo"), vec!["memo"]);
    }

    /// The body after a fence closes is read normally.
    #[test]
    fn resumes_after_the_fence_closes() {
        assert_eq!(parse("```\n#skipped\n```\n#after"), vec!["after"]);
    }

    /// An unclosed fence makes everything after it code.
    #[test]
    fn treats_an_unclosed_fence_as_code_to_the_end() {
        assert_eq!(parse("#before\n```\n#skipped"), vec!["before"]);
    }

    /// Returns the spelling as typed. If `#CognitiveBias` came back as
    /// `#cognitivebias`, the writer would read it as "that tag cannot be set".
    #[test]
    fn keeps_the_spelling_a_tag_was_written_with() {
        assert_eq!(parse("#CognitiveBias を疑う"), vec!["CognitiveBias"]);
    }

    /// `#Rust` and `#rust` are the same tag to the writer. Counted separately, the
    /// same category shows up twice in the list. The spelling seen first is kept.
    #[test]
    fn folds_case_when_deduping_and_keeps_the_first_spelling() {
        assert_eq!(parse("#Rust と #rust と #RUST"), vec!["Rust"]);
    }

    /// There is one matching rule. If looking up by key and comparing two tags gave
    /// different answers, a tag could appear in the list yet not filter.
    #[test]
    fn comparing_two_tags_agrees_with_folding_them() {
        for (a, b) in [("Rust", "rust"), ("Rust", "Ruby"), ("設計", "設計")] {
            assert_eq!(same_tag(a, b), fold_tag(a) == fold_tag(b), "{a} {b}");
        }
    }

    /// Japanese has no upper or lower case. Returned intact, as is.
    #[test]
    fn keeps_japanese_tags_as_written() {
        assert_eq!(parse("#設計 #カタカナ"), vec!["設計", "カタカナ"]);
    }

    #[test]
    fn finds_nothing_in_text_without_tags() {
        assert_eq!(parse("ただの本文"), Vec::<String>::new());
    }

    /// Makes the form passed by a chip or an argument equal to the form picked from
    /// the body. The spelling is not touched; matching is the job of `same_tag`.
    #[test]
    fn normalizes_an_external_tag_to_the_parsed_form() {
        assert_eq!(normalize("#Sync"), "Sync");
        assert_eq!(normalize(" 設計 "), "設計");
        assert_eq!(normalize("#"), "");
    }

    /// When a frontmatter tag and a body `#tag` differ only in case, they fold into
    /// one. The frontmatter side is kept, since that is the form the note names itself with.
    #[test]
    fn merging_folds_case_and_keeps_the_frontmatter_spelling() {
        assert_eq!(
            merge(vec!["Memo".to_string()], "本文 #memo #rust"),
            vec!["Memo", "rust"]
        );
    }

    /// A tag already saved in lowercase comes out in lowercase, as is.
    #[test]
    fn leaves_tags_saved_in_lowercase_alone() {
        assert_eq!(merge(vec!["memo".to_string()], "本文 #memo"), vec!["memo"]);
    }

    /// The frontmatter arrives as written, so one note can claim both `Memo` and
    /// `memo`. If a note claims the same category twice, the counting side reads
    /// that one note as two.
    #[test]
    fn merging_folds_two_spellings_that_came_from_the_frontmatter() {
        assert_eq!(
            merge(vec!["Memo".to_string(), "memo".to_string()], "本文"),
            vec!["Memo"]
        );
    }

    /// There is one rule for choosing the representative spelling. In order of
    /// appearance; the one seen first is kept.
    #[test]
    fn folding_a_list_keeps_the_first_spelling_of_each_tag() {
        let tags = ["Memo", "rust", "MEMO", "Rust", "設計"].map(String::from);
        assert_eq!(fold_unique(tags.to_vec()), vec!["Memo", "rust", "設計"]);
    }

    #[test]
    fn folding_an_empty_list_yields_nothing() {
        assert_eq!(fold_unique(Vec::new()), Vec::<String>::new());
    }

    #[test]
    fn ignores_a_bare_hash() {
        assert_eq!(parse("# "), Vec::<String>::new());
        assert_eq!(parse("#"), Vec::<String>::new());
    }

    // ──────────── boundaries ────────────

    #[test]
    fn finds_nothing_in_empty_text() {
        assert_eq!(parse(""), Vec::<String>::new());
    }

    /// A `#` at the end of the body has not a single character after it.
    #[test]
    fn ignores_a_hash_at_the_very_end() {
        assert_eq!(parse("終わり#"), Vec::<String>::new());
        assert_eq!(parse("end #"), Vec::<String>::new());
    }

    /// A `#` right after a tag is inside the word. `#a#b` is the one word `a#b` with a
    /// `#` in front.
    #[test]
    fn a_hash_right_after_a_tag_is_inside_the_word() {
        assert_eq!(parse("#a#b"), vec!["a"]);
    }

    /// In `##a` the first is an empty tag, and the second is preceded by `#`, so it is a boundary.
    #[test]
    fn a_doubled_hash_still_yields_the_tag() {
        assert_eq!(parse("##a"), vec!["a"]);
    }

    /// Kanji, digits, `_` and `-` are all tag characters. Right before, they make the
    /// `#` word-internal.
    #[test]
    fn ignores_a_hash_glued_to_the_previous_word() {
        assert_eq!(parse("設計#tag"), Vec::<String>::new());
        assert_eq!(parse("v2#tag"), Vec::<String>::new());
        assert_eq!(parse("a_#tag"), Vec::<String>::new());
        assert_eq!(parse("a-#tag"), Vec::<String>::new());
    }

    /// Fullwidth punctuation is a boundary. A fullwidth character right after is inside the tag.
    #[test]
    fn stops_at_fullwidth_punctuation_and_keeps_multibyte_tags() {
        assert_eq!(parse("「#タグ」"), vec!["タグ"]);
        assert_eq!(parse("#タグ!"), vec!["タグ"]);
        assert_eq!(parse("#2026 年"), vec!["2026"]);
    }

    /// With several code spans on one line, the body between them is still read.
    #[test]
    fn reads_the_text_between_two_code_spans() {
        assert_eq!(parse("`a` #one `b` #two `c`"), vec!["one", "two"]);
    }
}
