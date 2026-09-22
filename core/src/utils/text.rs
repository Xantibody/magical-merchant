//! Lowercasing used for search matching.

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

#[cfg(test)]
mod tests {
    use super::*;

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
