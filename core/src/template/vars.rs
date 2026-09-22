//! Replace the `{{...}}` in a template body with the values at the moment a note is created.
//!
//! Inside the template file `{{date}}` is just a string; it has meaning only once, at
//! creation. No variable remains in the note written out: if one did, the file could not
//! say "which day's date" when opened later.

use chrono::{DateTime, Datelike, Local, Timelike};

/// Only the weekday names depend on the language. The order of date and time is a record
/// that stays in the file, not the device's language, so it is fixed to the ISO order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarLocale {
    Ja,
    En,
}

impl VarLocale {
    /// An unknown language falls back to English. The same call as `resolveLocale` in
    /// `i18n.ts`: pick the one more likely to be readable over one that is not.
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

/// One token of a date pattern. A pair of "how it is written" and "how its value is made".
type Token = (&'static str, fn(DateTime<Local>) -> String);

/// `YYYY` does not need to come before `MM` (the first characters differ, so they do not
/// collide), but they are listed in reading order.
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

/// Resolve a template body. `prev` is the `[[ID]]` link to the most recent note, or
/// `None` when there is none yet.
///
/// Without `prev`, every line containing `{{prev}}` is dropped whole. Collapsing it to an
/// empty string leaves a line of only `前回: ` every time, so the first note made from a
/// template always gets a meaningless line. Losing the whole line when it is used mid-
/// sentence is accepted; "fold the line and its format together" gives a more predictable result.
#[must_use]
pub(crate) fn resolve_vars(
    body: &str,
    now: DateTime<Local>,
    prev: Option<&str>,
    locale: VarLocale,
) -> String {
    let mut out = String::with_capacity(body.len());
    let mut first = true;
    let mut in_example = false;

    for line in body.split('\n') {
        if in_example {
            if !ends_example(line) {
                continue;
            }
            in_example = false;
        }
        if is_example_marker(line) {
            in_example = true;
            continue;
        }
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

/// Whether the whole line is `{{eg}}`. It is the opening marker of an example block, and
/// is not written to the note itself. A `{{eg}}` inside a sentence is not a marker: if it
/// were, the rest of that line would silently vanish too.
fn is_example_marker(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed
        .strip_prefix("{{")
        .and_then(|rest| rest.strip_suffix("}}"))
        .is_some_and(|inner| var_name(inner) == "eg")
}

/// Whether the line ends an example block. The line that ends it stays in the note.
///
/// No closing marker is required. There is no guarantee a template author closes it
/// without ever slipping, and a forgotten close turning into "everything after vanishes"
/// is the worst outcome.
fn ends_example(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.is_empty() || trimmed.starts_with('#')
}

/// Whether the line contains `{{prev}}` (with or without a format argument).
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
            // An unclosed `{{` is not a variable. It stays as body text
            out.push_str(&rest[start..]);
            return;
        };
        let inner = &after[..end];
        if let Some(value) = resolve_one(inner, now, prev, locale) {
            out.push_str(&value);
        } else {
            // An unknown variable stays as written. Collapsed to empty, someone who
            // misspelled it can only notice that "it vanished"
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

/// The pattern is not passed to chrono's strftime. It is the user's string written in the
/// template, and a stray `%` would expand a format nobody wrote.
fn format_stamp(now: DateTime<Local>, pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut rest = pattern;

    while !rest.is_empty() {
        if let Some((token, render)) = TOKENS.iter().find(|(token, _)| rest.starts_with(token)) {
            out.push_str(&render(now));
            rest = &rest[token.len()..];
            continue;
        }
        // Non-token parts advance one character at a time. Advancing by byte splits a
        // boundary in mixed Japanese such as `{{date:YYYY年}}`
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

    /// 2026-08-31 (Mon) 09:12:45
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

    /// Only the weekday changes with the language. The date order does not.
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

    /// The first note made from a template does not keep a line of only `前回: `.
    #[test]
    fn a_line_with_prev_disappears_when_there_is_none() {
        assert_eq!(ja("# 今日\n\n前回: {{prev}}", None), "# 今日\n");
    }

    /// Only the `{{prev}}` line is dropped. The lines around it do not move.
    #[test]
    fn dropping_the_prev_line_keeps_its_neighbours() {
        assert_eq!(ja("上\n前回: {{prev}}\n下", None), "上\n下");
    }

    /// An example is not written to the note. Both the marker line and the block under it
    /// are dropped.
    #[test]
    fn an_example_block_never_reaches_the_note() {
        assert_eq!(
            ja(
                "### 状況\n{{eg}}\n- 本来の方向性は?\n- どんなズレがあったか?\n\n### 影響",
                None
            ),
            "### 状況\n\n### 影響"
        );
    }

    /// Even when the next heading comes with no blank line between, the example ends there.
    #[test]
    fn an_example_block_ends_at_the_next_heading() {
        assert_eq!(
            ja("### 状況\n{{eg}}\n- 問い\n### 影響", None),
            "### 状況\n### 影響"
        );
    }

    /// An example that runs to the end of the body. With no closing marker required, it
    /// can only end here.
    #[test]
    fn an_example_block_ends_at_the_body() {
        assert_eq!(ja("### 状況\n{{eg}}\n- 問い", None), "### 状況");
    }

    /// Variables inside an example are not resolved. The line vanishes whole, so there is no point.
    #[test]
    fn variables_inside_an_example_are_not_resolved() {
        assert_eq!(ja("{{eg}}\n{{date}} に何をしたか\n\n本文", None), "\n本文");
    }

    /// A one-line example can be written inside the marker. What drops is the marker line
    /// and the block under it.
    #[test]
    fn a_one_line_example_can_live_in_the_marker() {
        assert_eq!(
            ja("# 見出し\n{{eg: 一行の例}}\n\n本文", None),
            "# 見出し\n\n本文"
        );
    }

    /// Only a `{{eg}}` written alone on its line is a marker. One written inside a sentence
    /// does not open a block: if it did, the rest of that line would silently vanish too.
    #[test]
    fn eg_in_the_middle_of_a_line_is_not_a_marker() {
        assert_eq!(
            ja("例: {{eg}} と書く\n次の行", None),
            "例: {{eg}} と書く\n次の行"
        );
    }

    /// If a misspelled variable silently vanished, the author could not notice.
    #[test]
    fn an_unknown_variable_is_left_as_written() {
        assert_eq!(ja("{{tomorrow}}", None), "{{tomorrow}}");
    }

    #[test]
    fn an_unclosed_brace_is_body_text() {
        assert_eq!(ja("{{date", None), "{{date");
    }

    /// The pattern is not passed to strftime. `%` comes out as a literal character.
    #[test]
    fn a_percent_in_the_pattern_is_not_a_format() {
        assert_eq!(ja("{{date:100% YYYY}}", None), "100% 2026");
    }

    /// A multi-byte separator does not split a byte boundary.
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

    /// A body without variables does not change by one character.
    #[test]
    fn a_body_without_variables_is_untouched() {
        let body = "# 見出し\n\n- [ ] やること\n\n## メモ";
        assert_eq!(ja(body, None), body);
    }

    /// Written with whitespace inside, it still reads as the same variable.
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
