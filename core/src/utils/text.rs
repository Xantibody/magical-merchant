//! 検索の突き合わせに使う小文字化。

/// `str::to_lowercase` と同じ結果を返す。日本語が主の本文で速い。
///
/// 標準の `to_lowercase` は ASCII でない文字を 1 つずつ Unicode の変換表で
/// 引く。仮名・漢字・句読点には大文字も小文字も無いのに、その表引きが
/// 検索(全日・全ノートの本文を小文字にする)の 15% を占めていた。
///
/// 大小の区別が無いと分かっている範囲の文字はそのまま写し、ASCII は
/// ビット演算で倒す。それ以外の文字(ラテン拡張・ギリシャ文字など)が
/// 1 つでも混じる本文は、標準の `to_lowercase` にそっくり渡す —
/// 語末のシグマのような文脈依存の規則を、ここで真似はしない。
///
/// 「範囲に大小の区別が無い」ことはテストが全文字について確かめている。
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

/// 大文字・小文字の対応を 1 つも持たない、日本語の本文でよく出る範囲。
///
/// 全角英字(U+FF21–FF5A)はここに入れない — `Ａ` には `ａ` がある。
const CASELESS: &[std::ops::RangeInclusive<char>] = &[
    // 一般句読点(— … など)
    '\u{2000}'..='\u{206F}',
    // CJK の記号と句読点、ひらがな、カタカナ
    '\u{3000}'..='\u{30FF}',
    // CJK 統合漢字(拡張 A と本体)
    '\u{3400}'..='\u{4DBF}',
    '\u{4E00}'..='\u{9FFF}',
    // 半角カタカナ
    '\u{FF61}'..='\u{FF9F}',
];

fn is_caseless(c: char) -> bool {
    CASELESS.iter().any(|range| range.contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 速い経路の前提。範囲の中に 1 文字でも小文字の対応を持つものが
    /// 混じると、標準との結果がずれて検索の取りこぼしになる。
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

    /// 全角英字は範囲の外なので標準に倒される。
    #[test]
    fn fullwidth_latin_still_gets_lowercased() {
        assert_eq!(lowercase("ＡＢＣ"), "ａｂｃ");
    }
}
