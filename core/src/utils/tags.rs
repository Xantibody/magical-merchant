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

/// タグの同一性を決める鍵。突き合わせと数え上げにだけ使う。
///
/// 大文字小文字の違いは書き手にとって同じタグ。ASCII だけ小文字に寄せる
/// (日本語に大文字小文字は無く、ロケール依存の変換も持ち込まない)。
/// 同じ規則が `tauri-app/src/lib/tags.ts` の `foldTag` にもある。
#[must_use]
pub fn fold_tag(tag: &str) -> String {
    tag.to_ascii_lowercase()
}

/// 2 つのタグが同じか。綴りの違いは見ない。
///
/// AIDEV-NOTE: `fold_tag(a) == fold_tag(b)` と必ず同じ答えを返すこと(テストが縛る)。鍵が要らない側は確保を避ける。
#[must_use]
pub const fn same_tag(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// 大小だけ違う綴りを 1 つに畳む。出てきた順で、残すのは先に見たほう。
///
/// 「どの綴りを代表にするか」を決めるのはこの規則だけ。本文から拾うのも
/// frontmatter から来るのも、同じ答えでなければ画面ごとに違う字が出る。
/// `collect_span` は拾いながら同じ規則で落とす — 捨てる綴りを確保せずに
/// 済ませるため。同じ規則が `tauri-app/src/lib/tags.ts` の `foldUnique` にもある。
///
/// AIDEV-NOTE: 鍵の Map ではなく線形走査。タグは 1 枚あたり数個で、確保を増やさないほうが一覧の読み込みに効く。
fn fold_unique(tags: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut folded: Vec<String> = Vec::new();
    for tag in tags {
        if !folded.iter().any(|seen| same_tag(seen, &tag)) {
            folded.push(tag);
        }
    }
    folded
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
/// 大小だけ違うものは 1 つに畳み、綴りは frontmatter 側を残す — ノートが
/// 自分で名乗っている形だから。ファイルの中身には手を付けない。
///
/// frontmatter は書かれたまま届くので、その中だけで `Memo` と `memo` が
/// 並ぶこともある。畳むのは本文と突き合わせるときだけではない: ノートが
/// 名乗る一覧に同じ分類が二度出ると、数える側はその 1 枚を 2 枚と読む。
#[must_use]
pub fn merge(tags: Vec<String>, body: &str) -> Vec<String> {
    fold_unique(tags.into_iter().chain(parse(body)))
}

/// 外から渡されたタグを、`parse` が返す形に揃える。
///
/// 画面のチップや MCP の引数は `#Sync` のように `#` 付きで来ることがある。
/// 落とすのは飾りだけで、綴りには触らない — 大小を無視した突き合わせは
/// `same_tag` の仕事で、ここで潰すと打った字が呼び出し側から消える。
/// 空になったら「タグではない」ので、呼び出し側は捨てること。
#[must_use]
pub fn normalize(tag: &str) -> String {
    tag.trim().trim_start_matches('#').to_string()
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
/// 返すのは打たれた綴りそのもの。重複を落とすときだけ大小を無視する
/// (`same_tag`)ので、`#Memo` と `#memo` は 1 つになり、残るのは先に
/// 出てきたほう。
///
/// 文字を 1 つずつ見ないで `#` まで飛ぶ。`is_alphanumeric` は日本語の
/// 1 文字ごとに Unicode の表を引くので、本文を全文なぞると一覧の
/// 読み込みで最も高くつく処理になっていた。タグの有無を決めるのは
/// `#` の直前の 1 文字と直後のタグ文字だけで、それ以外は見なくてよい。
fn collect_span(span: &str, tags: &mut Vec<String>) {
    let mut pos = 0;
    while let Some(offset) = span[pos..].find('#') {
        let hash = pos + offset;
        let start = hash + '#'.len_utf8();
        pos = start;

        // 直前がタグ文字なら語中の `#`。`#a#b` の 2 つ目もここに入る
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

    /// 打った綴りをそのまま返す。`#CognitiveBias` が `#cognitivebias` に
    /// なると、書き手は「そのタグは付けられない」と読む。
    #[test]
    fn keeps_the_spelling_a_tag_was_written_with() {
        assert_eq!(parse("#CognitiveBias を疑う"), vec!["CognitiveBias"]);
    }

    /// `#Rust` と `#rust` は書き手にとって同じタグ。別々に数えると、
    /// 同じ分類が一覧に二重に並ぶ。残すのは最初に見た綴り。
    #[test]
    fn folds_case_when_deduping_and_keeps_the_first_spelling() {
        assert_eq!(parse("#Rust と #rust と #RUST"), vec!["Rust"]);
    }

    /// 突き合わせの規則は 1 つ。鍵で引くときと 2 つを比べるときで
    /// 答えが違うと、一覧に出るのに絞り込めないタグができる。
    #[test]
    fn comparing_two_tags_agrees_with_folding_them() {
        for (a, b) in [("Rust", "rust"), ("Rust", "Ruby"), ("設計", "設計")] {
            assert_eq!(same_tag(a, b), fold_tag(a) == fold_tag(b), "{a} {b}");
        }
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
    /// 綴りには触らない — 突き合わせは `same_tag` の仕事。
    #[test]
    fn normalizes_an_external_tag_to_the_parsed_form() {
        assert_eq!(normalize("#Sync"), "Sync");
        assert_eq!(normalize(" 設計 "), "設計");
        assert_eq!(normalize("#"), "");
    }

    /// frontmatter のタグと本文の `#タグ` が大小だけ違うとき、1 つに畳む。
    /// 残すのは frontmatter 側 — ノートが自分で名乗っている形なので。
    #[test]
    fn merging_folds_case_and_keeps_the_frontmatter_spelling() {
        assert_eq!(
            merge(vec!["Memo".to_string()], "本文 #memo #rust"),
            vec!["Memo", "rust"]
        );
    }

    /// すでに小文字で保存されたタグは、そのまま小文字で出る。
    #[test]
    fn leaves_tags_saved_in_lowercase_alone() {
        assert_eq!(merge(vec!["memo".to_string()], "本文 #memo"), vec!["memo"]);
    }

    /// frontmatter は書かれたまま届くので、1 枚が `Memo` と `memo` の両方を
    /// 名乗ることがある。ノートが同じ分類を二度名乗ると、数える側はその 1 枚を
    /// 2 件と読む。
    #[test]
    fn merging_folds_two_spellings_that_came_from_the_frontmatter() {
        assert_eq!(
            merge(vec!["Memo".to_string(), "memo".to_string()], "本文"),
            vec!["Memo"]
        );
    }

    /// 代表の綴りを決める規則は 1 つ。出てきた順で、残すのは先に見たほう。
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

    // ──────────── 境界 ────────────

    #[test]
    fn finds_nothing_in_empty_text() {
        assert_eq!(parse(""), Vec::<String>::new());
    }

    /// 本文の末尾の `#` は、その先に 1 文字も無い。
    #[test]
    fn ignores_a_hash_at_the_very_end() {
        assert_eq!(parse("終わり#"), Vec::<String>::new());
        assert_eq!(parse("end #"), Vec::<String>::new());
    }

    /// タグの直後の `#` は語中。`#a#b` は `a#b` という 1 語に `#` を付けたもの。
    #[test]
    fn a_hash_right_after_a_tag_is_inside_the_word() {
        assert_eq!(parse("#a#b"), vec!["a"]);
    }

    /// `##a` の 1 つ目は空タグ、2 つ目の直前は `#` なので境界。
    #[test]
    fn a_doubled_hash_still_yields_the_tag() {
        assert_eq!(parse("##a"), vec!["a"]);
    }

    /// 漢字・数字・`_`・`-` はどれもタグ文字。直前にあれば語中の `#`。
    #[test]
    fn ignores_a_hash_glued_to_the_previous_word() {
        assert_eq!(parse("設計#tag"), Vec::<String>::new());
        assert_eq!(parse("v2#tag"), Vec::<String>::new());
        assert_eq!(parse("a_#tag"), Vec::<String>::new());
        assert_eq!(parse("a-#tag"), Vec::<String>::new());
    }

    /// 全角記号は境界。直後の全角文字はタグの中。
    #[test]
    fn stops_at_fullwidth_punctuation_and_keeps_multibyte_tags() {
        assert_eq!(parse("「#タグ」"), vec!["タグ"]);
        assert_eq!(parse("#タグ!"), vec!["タグ"]);
        assert_eq!(parse("#2026 年"), vec!["2026"]);
    }

    /// 1 行に複数のコードスパンがあっても、その間の本文は読む。
    #[test]
    fn reads_the_text_between_two_code_spans() {
        assert_eq!(parse("`a` #one `b` #two `c`"), vec!["one", "two"]);
    }
}
