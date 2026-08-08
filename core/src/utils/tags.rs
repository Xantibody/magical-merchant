//! 本文中の `#タグ` を拾う。
//!
//! タグを別枠で管理させると、書く手が止まって分類の作業になる。本文に混ぜて
//! 書けるなら、書いた勢いのまま残せる。
//!
//! 同じ規則が `tauri-app/src/lib/tags.ts` にもある。あちらは画面で本文を
//! そのまま解釈する必要があり（入力補完と色付け）、こちらは一覧を作るのに
//! ノート全文を読む必要がある。片方を直したらもう片方も直すこと。

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
#[must_use]
pub fn parse(text: &str) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    let mut at_boundary = true;

    let mut chars = text.char_indices().peekable();
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
            let tag = &text[start..end];
            if !tags.iter().any(|seen| seen == tag) {
                tags.push(tag.to_string());
            }
        }
        // タグを 1 つ読んだ直後の `#` は、直前がタグ文字なので境界ではない。
        at_boundary = end == start;
    }

    tags
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

    #[test]
    fn finds_nothing_in_text_without_tags() {
        assert_eq!(parse("ただの本文"), Vec::<String>::new());
    }

    #[test]
    fn ignores_a_bare_hash() {
        assert_eq!(parse("# "), Vec::<String>::new());
        assert_eq!(parse("#"), Vec::<String>::new());
    }
}
