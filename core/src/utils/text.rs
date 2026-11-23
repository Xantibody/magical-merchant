//! Lowercasing used for search matching, and the excerpt cut around a match.

/// Returns the same result as `str::to_lowercase`. Fast on mostly Japanese text.
///
/// The standard `to_lowercase` looks up every non-ASCII character one by one in
/// the Unicode mapping table. Kana, kanji and punctuation have neither upper nor
/// lower case, yet that table lookup took 15% of search (lowercasing the body of
/// every day and every note).
///
/// Characters in ranges known to have no case are copied as is, and ASCII is
/// folded with a bit operation. A body with even one other character (Latin
/// Extended, Greek and so on) is handed whole to the standard `to_lowercase`:
/// context-dependent rules like the final sigma are not imitated here.
///
/// That "the ranges have no case" is verified by a test over every character.
#[must_use]
pub(crate) fn lowercase(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else if is_caseless(c) {
            out.push(c);
        } else {
            return text.to_lowercase();
        }
    }
    out
}

/// Ranges common in Japanese text that have no upper/lower case pair at all.
///
/// Fullwidth Latin letters (U+FF21 to FF5A) are not included: `Ａ` has `ａ`.
const CASELESS: &[std::ops::RangeInclusive<char>] = &[
    // General Punctuation (em dash, ellipsis and so on)
    '\u{2000}'..='\u{206F}',
    // CJK Symbols and Punctuation, Hiragana, Katakana
    '\u{3000}'..='\u{30FF}',
    // CJK Unified Ideographs (Extension A and the main block)
    '\u{3400}'..='\u{4DBF}',
    '\u{4E00}'..='\u{9FFF}',
    // Halfwidth Katakana
    '\u{FF61}'..='\u{FF9F}',
];

fn is_caseless(c: char) -> bool {
    CASELESS.iter().any(|range| range.contains(&c))
}

/// The cut excerpt and where the query matches inside it (in characters).
pub(crate) struct Excerpt {
    pub(crate) text: String,
    /// `None` when there is no match in the body (only a tag was hit).
    pub(crate) match_start: Option<usize>,
    /// How many characters of `text` the match covers. Set together with `match_start`.
    pub(crate) match_len: Option<usize>,
}

/// Cut the head of the text as the excerpt. It is [`snippet`] with an empty needle; nothing
/// is matched, so no lowercased copy is needed (`lowered` is used only to find the match).
pub(crate) fn head(text: &str, context: usize) -> String {
    snippet(text, text, "", context).text
}

/// Cut `context` characters on each side of the hit without breaking a character
/// boundary. `lowered` is the lowercased `text` used for matching. It is taken rather than
/// rebuilt because this runs once per hit.
pub(crate) fn snippet(text: &str, lowered: &str, needle: &str, context: usize) -> Excerpt {
    let needle_len = needle.chars().count();
    // Where the match lies in `text`, as (start, length) in characters. If the hit was
    // outside the body (a note's tag, for instance), cut from the head. The same with an
    // empty needle (a list narrowed by tag only): there is nothing to highlight.
    let found = if needle.is_empty() {
        None
    } else {
        lowered.find(needle).and_then(|byte| {
            let at = lowered[..byte].chars().count();
            // Nearly always each character lowercases to one, and a position in `lowered`
            // is the same position in `text`. Two counts settle that without a lookup per
            // character, which is what made lowercasing a tenth of a search
            if lowered.chars().count() == text.chars().count() {
                Some((at, needle_len))
            } else {
                span_in_text(text, at, needle_len)
            }
        })
    };
    let (at, len) = found.unwrap_or((0, needle_len));
    let end = at + len + context;
    let start = at.saturating_sub(context);

    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    // The leading ellipsis is one character too. Left out of the position, the highlight
    // is off by one character
    let match_start = found.map(|(at, _)| at - start + usize::from(start > 0));
    let match_len = found.map(|(_, len)| len);
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
                    match_len,
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
        match_len,
    }
}

/// Where a match found at character `at` of the lowercased text, `len` characters long,
/// lies in `text`, as (start, length) in `text`'s characters.
///
/// Lowercasing can turn one character into more (`İ` into `i` and a combining dot), so past
/// the first such character the two texts count differently. A match that starts or ends
/// inside what one character became takes that whole character. `None` only if the match
/// runs past the text, which a match in `lowercase(text)` cannot do; there is then no
/// highlight rather than a wrong one.
fn span_in_text(text: &str, at: usize, len: usize) -> Option<(usize, usize)> {
    let last = at + len.checked_sub(1)?;
    let mut lowered = 0;
    let mut start = None;
    for (index, c) in text.chars().enumerate() {
        let next = lowered + c.to_lowercase().count();
        if start.is_none() && at < next {
            start = Some(index);
        }
        if last < next {
            return start.map(|start| (start, index + 1 - start));
        }
        lowered = next;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The excerpt of `text` around `needle`, matched on the lowercased text as search does.
    fn cut(text: &str, needle: &str, context: usize) -> (String, Option<usize>, Option<usize>) {
        let excerpt = snippet(text, &lowercase(text), needle, context);
        (excerpt.text, excerpt.match_start, excerpt.match_len)
    }

    /// Exactly `context` characters on each side fit whole; nothing is elided.
    #[test]
    fn a_window_exactly_as_wide_as_the_context_is_not_elided() {
        assert_eq!(
            cut("前前リトライ後後", "リトライ", 2),
            ("前前リトライ後後".to_string(), Some(2), Some(4))
        );
    }

    /// One character more on a side and that side gets an ellipsis.
    #[test]
    fn a_window_past_the_context_is_elided_on_both_sides() {
        assert_eq!(
            cut("前前前リトライ後後後", "リトライ", 2).0,
            "…前前リトライ後後…"
        );
        assert_eq!(
            cut("前前リトライ後後後", "リトライ", 2).0,
            "前前リトライ後後…"
        );
        assert_eq!(
            cut("前前前リトライ後後", "リトライ", 2).0,
            "…前前リトライ後後"
        );
    }

    /// The leading ellipsis is a character of the excerpt, so the match starts one later.
    #[test]
    fn the_leading_ellipsis_counts_in_the_match_position() {
        let (text, start, len) = cut("abc NEEDLE def", "needle", 2);

        assert_eq!(text, "…c NEEDLE d…");
        assert_eq!((start, len), (Some(3), Some(6)));
    }

    #[test]
    fn a_newline_becomes_a_space() {
        assert_eq!(
            cut("一行目\nneedle\n三行目", "needle", 10).0,
            "一行目 needle 三行目"
        );
    }

    /// Japanese is three bytes a character; a byte position would land far past the match.
    #[test]
    fn positions_count_characters_not_bytes() {
        assert_eq!(cut("日本語の本文にリトライ", "リトライ", 40).1, Some(7));
    }

    /// An empty needle matches nothing, so the excerpt is the head of the text.
    #[test]
    fn an_empty_needle_cuts_the_head() {
        assert_eq!(
            cut("あいうえお", "", 3),
            ("あいう…".to_string(), None, None)
        );
        assert_eq!(head("あいうえお", 3), "あいう…");
    }

    /// A match can start or end between the two characters `İ` lowercases to. The highlight
    /// then takes the whole `İ`, never half of it.
    #[test]
    fn a_match_cutting_through_a_dotted_capital_i_takes_the_whole_letter() {
        let text = "aİb";
        let ends_inside = snippet(text, &lowercase(text), "ai", 40);
        assert_eq!(
            (ends_inside.match_start, ends_inside.match_len),
            (Some(0), Some(2))
        );
        let starts_inside = snippet(text, &lowercase(text), "\u{307}b", 40);
        assert_eq!(
            (starts_inside.match_start, starts_inside.match_len),
            (Some(1), Some(2))
        );
    }

    /// The premise of the fast path. If even one character in the ranges had a
    /// lowercase mapping, the result would differ from the standard and search would miss.
    #[test]
    fn every_char_in_the_caseless_ranges_lowercases_to_itself() {
        for range in CASELESS {
            for c in range.clone() {
                let mut lowered = c.to_lowercase();
                assert_eq!(lowered.next(), Some(c), "U+{:04X}", u32::from(c));
                assert_eq!(lowered.next(), None, "U+{:04X}", u32::from(c));
            }
        }
    }

    #[test]
    fn matches_the_standard_library_on_mixed_text() {
        for text in [
            "",
            "ASCII Only",
            "同期処理のリトライ戦略を詰める — Rust で",
            "半角ｶﾀｶﾅ と 全角Ａ",
            "ΣΊΣΥΦΟΣ",
            "İstanbul straße",
            "- [09:00:00] メモ {\"battery\":72}",
        ] {
            assert_eq!(lowercase(text), text.to_lowercase(), "{text}");
        }
    }

    /// Fullwidth Latin letters are outside the ranges, so they fall back to the standard.
    #[test]
    fn fullwidth_latin_still_gets_lowercased() {
        assert_eq!(lowercase("ＡＢＣ"), "ａｂｃ");
    }
}
