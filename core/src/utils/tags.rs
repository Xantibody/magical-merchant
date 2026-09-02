//! 本文中の `#タグ` を拾う。
//!
//! タグを別枠で管理させると、書く手が止まって分類の作業になる。本文に混ぜて
//! 書けるなら、書いた勢いのまま残せる。
//!
//! 同じ規則が `tauri-app/src/lib/tags.ts` にもある。あちらは画面で本文を
//! そのまま解釈する必要があり（入力補完と色付け）、こちらは一覧を作るのに
//! ノート全文を読む必要がある。片方を直したらもう片方も直すこと。
//!
//! ひとつだけ意図的に違う: コードフェンスとコードスパンを読み飛ばすのは
//! こちらだけ。読む対象が Markdown のノート全文だからで、あちらが読むのは
//! タイムラインの 1 行(コードの切り分けは markdown-it が先にやる)。

/// タグに使える文字。日本語のタグも書けるよう `is_alphanumeric` で見る。
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// 本文から `#タグ` を、出てきた順に重複なく返す。
///
/// `#` の直前がタグに使える文字でないこと。`https://example.com#frag` のような
/// URL の断片や、`C#` の `#` を拾わないため。
///
/// 「直前が空白」ではない。日本語は語の間に空白を置かないので、それだと
/// 「走った。#run」のような、ごく普通の書き方を取りこぼす。
///
/// `# 見出し` は `#` の直後が空白なので、そもそも 1 文字も一致しない。
///
/// コードの中は読まない。`#include` や `#define` は書き手がタグのつもりで
/// 打ったものではないし、プレビューもコードの中身には色を付けない。
#[must_use]
pub fn parse(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut fence: Option<(char, usize)> = None;

    for line in text.lines() {
        if let Some((marker, len)) = fence {
            // 開いたときより短い区切りでは閉じない
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

/// frontmatter のタグと本文の `#タグ` を、ノートが名乗る 1 つの一覧にする。
///
/// 本文に書かれた `#タグ` が今の入力方法。frontmatter に残っているのは
/// タグ欄で付けていた頃のもので、消すと過去のノートから分類が消える。
/// 見せる形は本文側の規則に合わせる — ファイルの中身には手を付けない。
#[must_use]
pub fn merge(mut tags: Vec<String>, body: &str) -> Vec<String> {
    for tag in &mut tags {
        tag.make_ascii_lowercase();
    }
    for tag in parse(body) {
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    tags
}

/// 外から渡されたタグを、`parse` が返す形に揃える。
///
/// 画面のチップや MCP の引数は `#Sync` のように `#` 付き・大文字混じりで
/// 来ることがある。本文から拾った `sync` と突き合わせる前にここを通す。
/// 空になったら「タグではない」ので、呼び出し側は捨てること。
#[must_use]
pub fn normalize(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_ascii_lowercase()
}

/// 行がコードフェンスの区切りなら、その記号と本数を返す。
fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let len = trimmed.chars().take_while(|&c| c == marker).count();
    (len >= 3).then_some((marker, len))
}

/// 1 行を、コードスパン(`` ` ``)の外側だけ読む。
fn collect_line(line: &str, tags: &mut Vec<String>) {
    let mut rest = line;
    while let Some(start) = rest.find('`') {
        collect_span(&rest[..start], tags);
        let after = &rest[start..];
        let ticks = after.chars().take_while(|&c| c == '`').count();
        let (delim, body) = after.split_at(ticks);
        // 閉じない `` ` `` はただの記号。以降は本文として読む
        rest = body.find(delim).map_or(body, |end| &body[end + ticks..]);
    }
    collect_span(rest, tags);
}

/// コードの外にある一続きの文字列からタグを拾う。
///
/// 大文字小文字の違いは書き手にとって同じタグ。ASCII だけ小文字に寄せる
/// (日本語に大文字小文字は無く、ロケール依存の変換も持ち込まない)。
fn collect_span(span: &str, tags: &mut Vec<String>) {
    let mut at_boundary = true;

    let mut chars = span.char_indices().peekable();
    while let Some((index, c)) = chars.next() {
        if c != '#' || !at_boundary {
            at_boundary = !is_tag_char(c);
            continue;
        }

        let start = index + '#'.len_utf8();
        let mut end = start;
        while chars.peek().is_some_and(|&(_, next)| is_tag_char(next)) {
            let (offset, next) = chars.next().unwrap_or((end, ' '));
            end = offset + next.len_utf8();
        }

        if end > start {
            let tag = span[start..end].to_ascii_lowercase();
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
        // タグを 1 つ読んだ直後の `#` は、直前がタグ文字なので境界ではない。
        at_boundary = end == start;
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

    /// `# ` で始まる行は Markdown の見出し。タグとして数えると、ほぼ全ての
    /// ノートに空のタグが付く。
    #[test]
    fn ignores_a_markdown_heading() {
        assert_eq!(parse("# 見出し\n本文"), Vec::<String>::new());
    }

    /// URL の断片や語中の `#` は書き手がタグのつもりで打ったものではない。
    #[test]
    fn ignores_a_hash_that_is_not_at_a_word_boundary() {
        assert_eq!(parse("https://example.com/a#frag"), Vec::<String>::new());
        assert_eq!(parse("C#"), Vec::<String>::new());
    }

    /// 日本語は語の間に空白を置かない。句点の直後を拾えないと、書いたとおりの
    /// タグがほとんど落ちる。
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

    /// コードの中の `#` は書き手が打ったタグではない。プレビューも
    /// コードの中身には色を付けない — 一覧のチップだけが拾っていた。
    #[test]
    fn ignores_hashes_inside_a_fenced_code_block() {
        let text = "本文 #real\n\n```c\n#include <stdio.h>\n#define N 1\n```\n\n続き";
        assert_eq!(parse(text), vec!["real"]);
    }

    #[test]
    fn ignores_hashes_inside_an_inline_code_span() {
        assert_eq!(parse("`#define` は展開される #memo"), vec!["memo"]);
    }

    /// フェンスを閉じた後の本文は普通に読む。
    #[test]
    fn resumes_after_the_fence_closes() {
        assert_eq!(parse("```\n#skipped\n```\n#after"), vec!["after"]);
    }

    /// 閉じていないフェンスは、そこから先が全部コード。
    #[test]
    fn treats_an_unclosed_fence_as_code_to_the_end() {
        assert_eq!(parse("#before\n```\n#skipped"), vec!["before"]);
    }

    /// `#Rust` と `#rust` は書き手にとって同じタグ。別々に数えると、
    /// 同じ分類が一覧に二重に並ぶ。
    #[test]
    fn normalizes_ascii_tags_to_lowercase() {
        assert_eq!(parse("#Rust と #rust と #RUST"), vec!["rust"]);
    }

    /// 日本語には大文字小文字が無い。壊さずそのまま返す。
    #[test]
    fn keeps_japanese_tags_as_written() {
        assert_eq!(parse("#設計 #カタカナ"), vec!["設計", "カタカナ"]);
    }

    #[test]
    fn finds_nothing_in_text_without_tags() {
        assert_eq!(parse("ただの本文"), Vec::<String>::new());
    }

    /// チップや引数で渡される形と、本文から拾った形を同じにする。
    #[test]
    fn normalizes_an_external_tag_to_the_parsed_form() {
        assert_eq!(normalize("#Sync"), "sync");
        assert_eq!(normalize(" 設計 "), "設計");
        assert_eq!(normalize("#"), "");
    }

    #[test]
    fn ignores_a_bare_hash() {
        assert_eq!(parse("# "), Vec::<String>::new());
        assert_eq!(parse("#"), Vec::<String>::new());
    }
}
