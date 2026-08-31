//! テンプレ本文の `{{…}}` を、ノートを作るその瞬間の値に置き換える。
//!
//! テンプレファイルの中では `{{date}}` はただの文字列で、意味を持つのは
//! 作成の一度きり。書き出したノートに変数は残らない — 残すと、あとで開いた
//! ときに「いつの日付なのか」がファイルからは分からなくなる。

use chrono::{DateTime, Datelike, Local, Timelike};

/// 曜日の呼び名だけが言語に依る。日付と時刻の並びは端末の言語ではなく
/// ファイルに残る記録なので、ISO の並びで固定する。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarLocale {
    Ja,
    En,
}

impl VarLocale {
    /// 知らない言語は英語に倒す。`i18n.ts` の `resolveLocale` と同じ判断で、
    /// 読めない言語より読める可能性の高いほうを選ぶ。
    #[must_use]
    pub fn parse(tag: &str) -> Self {
        if tag.to_ascii_lowercase().starts_with("ja") {
            Self::Ja
        } else {
            Self::En
        }
    }
}

const JA_WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];
const EN_WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// 日付パターンのトークン 1 つ。「書き方」と「その値の作り方」の対。
type Token = (&'static str, fn(DateTime<Local>) -> String);

/// `YYYY` が `MM` より先に来る必要はない (先頭の文字が違うので衝突しない) が、
/// 読む順と同じに並べてある。
const TOKENS: &[Token] = &[
    ("YYYY", |d| format!("{:04}", d.year())),
    ("MM", |d| format!("{:02}", d.month())),
    ("DD", |d| format!("{:02}", d.day())),
    ("HH", |d| format!("{:02}", d.hour())),
    ("mm", |d| format!("{:02}", d.minute())),
    ("ss", |d| format!("{:02}", d.second())),
];

const DEFAULT_DATE: &str = "YYYY-MM-DD";
const DEFAULT_TIME: &str = "HH:mm";

/// テンプレ本文を解決する。`prev` は直近ノートへの `[[ID]]` リンクで、
/// まだ 1 本も無ければ `None`。
///
/// `prev` が無いときは `{{prev}}` を含む行を丸ごと落とす。空文字に潰すと
/// 「前回: 」だけの行が毎回残り、テンプレを使い始めた最初のノートに必ず
/// 意味のない行が生まれる。文中で使いたい場合に行ごと消えるのは承知の上で、
/// 「行の書式ごと畳む」ほうが結果を予測しやすい。
#[must_use]
pub(crate) fn resolve_vars(
    body: &str,
    now: DateTime<Local>,
    prev: Option<&str>,
    locale: VarLocale,
) -> String {
    let mut out = String::with_capacity(body.len());
    let mut first = true;

    for line in body.split('\n') {
        if prev.is_none() && line_uses_prev(line) {
            continue;
        }
        if !first {
            out.push('\n');
        }
        first = false;
        resolve_line(line, now, prev.unwrap_or(""), locale, &mut out);
    }

    out
}

/// 行に `{{prev}}` が(書式指定つきでも)含まれるか。
fn line_uses_prev(line: &str) -> bool {
    let mut rest = line;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            return false;
        };
        if var_name(&after[..end]) == "prev" {
            return true;
        }
        rest = &after[end + 2..];
    }
    false
}

fn var_name(inner: &str) -> &str {
    inner.split_once(':').map_or(inner, |(name, _)| name).trim()
}

fn resolve_line(line: &str, now: DateTime<Local>, prev: &str, locale: VarLocale, out: &mut String) {
    let mut rest = line;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            // 閉じていない `{{` は変数ではない。本文としてそのまま残す
            out.push_str(&rest[start..]);
            return;
        };
        let inner = &after[..end];
        if let Some(value) = resolve_one(inner, now, prev, locale) {
            out.push_str(&value);
        } else {
            // 知らない変数は書いたまま残す。空に潰すと、綴りを間違えた人は
            // 「消えた」ことにしか気づけない
            out.push_str("{{");
            out.push_str(inner);
            out.push_str("}}");
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
}

fn resolve_one(inner: &str, now: DateTime<Local>, prev: &str, locale: VarLocale) -> Option<String> {
    let (name, arg) = match inner.split_once(':') {
        Some((name, arg)) => (name.trim(), Some(arg.trim())),
        None => (inner.trim(), None),
    };

    match name {
        "date" => Some(format_stamp(now, arg.unwrap_or(DEFAULT_DATE))),
        "time" => Some(format_stamp(now, arg.unwrap_or(DEFAULT_TIME))),
        "weekday" => Some(weekday(now, locale).to_string()),
        "prev" => Some(prev.to_string()),
        _ => None,
    }
}

fn weekday(now: DateTime<Local>, locale: VarLocale) -> &'static str {
    let index = now.weekday().num_days_from_sunday() as usize;
    let names = match locale {
        VarLocale::Ja => &JA_WEEKDAYS,
        VarLocale::En => &EN_WEEKDAYS,
    };
    names.get(index).copied().unwrap_or("")
}

/// パターンを chrono の strftime に渡さない。これはテンプレに書かれた
/// ユーザーの文字列で、`%` が紛れ込めば書かれていない書式が展開される。
fn format_stamp(now: DateTime<Local>, pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut rest = pattern;

    while !rest.is_empty() {
        if let Some((token, render)) = TOKENS.iter().find(|(token, _)| rest.starts_with(token)) {
            out.push_str(&render(now));
            rest = &rest[token.len()..];
            continue;
        }
        // トークンでない部分は 1 文字ずつ。バイトで進めると
        // `{{date:YYYY年}}` のような日本語混じりで境界を割る
        let Some(ch) = rest.chars().next() else {
            break;
        };
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 2026-08-31 (月) 09:12:45
    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 8, 31, 9, 12, 45).unwrap()
    }

    fn ja(body: &str, prev: Option<&str>) -> String {
        resolve_vars(body, now(), prev, VarLocale::Ja)
    }

    #[test]
    fn date_defaults_to_the_iso_day() {
        assert_eq!(ja("# Daily {{date}}", None), "# Daily 2026-08-31");
    }

    #[test]
    fn date_takes_a_format_argument() {
        assert_eq!(ja("{{date:YYYY-MM}}", None), "2026-08");
        assert_eq!(ja("{{date:YYYY/MM/DD}}", None), "2026/08/31");
    }

    #[test]
    fn time_defaults_to_hours_and_minutes() {
        assert_eq!(ja("{{time}}", None), "09:12");
        assert_eq!(ja("{{time:HH:mm:ss}}", None), "09:12:45");
    }

    /// 曜日だけが言語で変わる。日付の並びは変わらない。
    #[test]
    fn the_weekday_follows_the_locale() {
        assert_eq!(ja("{{weekday}}", None), "月");
        assert_eq!(
            resolve_vars("{{weekday}}", now(), None, VarLocale::En),
            "Mon"
        );
    }

    #[test]
    fn prev_becomes_the_note_link() {
        assert_eq!(
            ja("前回: {{prev}}", Some("[[20260830_091200]]")),
            "前回: [[20260830_091200]]"
        );
    }

    /// テンプレを使い始めた最初のノートに「前回: 」だけの行を残さない。
    #[test]
    fn a_line_with_prev_disappears_when_there_is_none() {
        assert_eq!(ja("# 今日\n\n前回: {{prev}}", None), "# 今日\n");
    }

    /// 落とすのは `{{prev}}` の行だけ。前後の行は動かない。
    #[test]
    fn dropping_the_prev_line_keeps_its_neighbours() {
        assert_eq!(ja("上\n前回: {{prev}}\n下", None), "上\n下");
    }

    /// 綴りを間違えた変数が黙って消えると、書いた人は気づけない。
    #[test]
    fn an_unknown_variable_is_left_as_written() {
        assert_eq!(ja("{{tomorrow}}", None), "{{tomorrow}}");
    }

    #[test]
    fn an_unclosed_brace_is_body_text() {
        assert_eq!(ja("{{date", None), "{{date");
    }

    /// パターンは strftime に渡さない。`%` はそのまま文字として出る。
    #[test]
    fn a_percent_in_the_pattern_is_not_a_format() {
        assert_eq!(ja("{{date:100% YYYY}}", None), "100% 2026");
    }

    /// マルチバイトの区切りでバイト境界を割らない。
    #[test]
    fn a_pattern_can_contain_japanese() {
        assert_eq!(ja("{{date:YYYY年MM月DD日}}", None), "2026年08月31日");
    }

    #[test]
    fn several_variables_can_share_one_line() {
        assert_eq!(
            ja("{{date}} ({{weekday}}) {{time}}", None),
            "2026-08-31 (月) 09:12"
        );
    }

    /// 変数を含まない本文は 1 文字も変わらない。
    #[test]
    fn a_body_without_variables_is_untouched() {
        let body = "# 見出し\n\n- [ ] やること\n\n## メモ";
        assert_eq!(ja(body, None), body);
    }

    /// 空白を挟んで書かれていても同じ変数として読む。
    #[test]
    fn whitespace_inside_the_braces_is_ignored() {
        assert_eq!(ja("{{ date }}", None), "2026-08-31");
    }

    #[test]
    fn locale_parse_falls_back_to_english() {
        assert_eq!(VarLocale::parse("ja"), VarLocale::Ja);
        assert_eq!(VarLocale::parse("ja-JP"), VarLocale::Ja);
        assert_eq!(VarLocale::parse("en-US"), VarLocale::En);
        assert_eq!(VarLocale::parse("fr"), VarLocale::En);
    }
}
