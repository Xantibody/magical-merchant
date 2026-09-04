use chrono::{DateTime, FixedOffset, Local, NaiveTime};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};

/// 行末に載せるものは `Context` そのものとは限らない。日ファイルでは
/// 端末情報を先頭に追い出した縮約版を書く。
#[must_use]
pub fn format_timeline_line<C: Serialize>(
    text: &str,
    timestamp: DateTime<Local>,
    context: &C,
) -> String {
    let time = timestamp.format("%H:%M:%S");
    match serde_json::to_string(context) {
        Ok(json) if json != "{}" => format!("- [{time}] {text} {json}"),
        _ => format!("- [{time}] {text}"),
    }
}

/// `- [HH:MM:SS] ` を prefix として切り出す。
pub(crate) fn split_time_prefix(entry: &str) -> Option<(&str, &str)> {
    let rest = entry.strip_prefix("- [")?;
    let close = rest.find("] ")?;
    let time = &rest[..close];
    if time.len() != 8 || !time.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return None;
    }
    Some(entry.split_at("- [".len() + close + "] ".len()))
}

/// 末尾のコンテキスト JSON（最後の " {" 以降が JSON オブジェクトなら）を返す。
pub(crate) fn split_context_json(rest: &str) -> Option<&str> {
    let start = rest.rfind(" {")?;
    let candidate = &rest[start + 1..];
    // `Value` を組み立てて is_object を見ない: candidate は必ず `{` で始まるので、
    // 構文として通れば JSON オブジェクト以外にはなり得ない。`IgnoredAny` なら
    // 検証だけを行い、Map も String も確保しない。
    serde_json::from_str::<IgnoredAny>(candidate)
        .ok()
        .map(|_| candidate)
}

/// 時刻プレフィックスと記録時コンテキストを取り除き、ユーザーが書いた本文だけを返す。
#[must_use]
pub fn strip_timeline_prefix(entry: &str) -> &str {
    let rest = split_time_prefix(entry).map_or(entry, |(_, rest)| rest);
    split_context_json(rest).map_or(rest, |json| rest[..rest.len() - json.len()].trim_end())
}

/// エントリの `HH:MM:SS`。プレフィックスが無い旧い行では `None`。
#[must_use]
pub fn timeline_entry_time(entry: &str) -> Option<&str> {
    let (prefix, _) = split_time_prefix(entry)?;
    prefix
        .strip_prefix("- [")
        .and_then(|t| t.strip_suffix("] "))
}

/// 1 行を分解したもの。行の形(時刻の括弧、行末 JSON)を読む側に見せない。
///
/// 画面は行のまま扱えるが、外部(MCP)に渡すときは書式ではなく値が要る。
/// 突き合わせたいのは「いつ・どこで」であって、`- [` の位置ではない。
#[derive(Debug, Clone, PartialEq)]
pub struct TimelineEntry {
    /// 端末のローカル時刻。旧い行では `None`。
    pub time: Option<NaiveTime>,
    /// 書き手が打った本文だけ。
    pub text: String,
    /// 記録時の端末の状態。何も残っていなければ既定値。
    pub context: Context,
    /// どの入り口で書かれたか(`app` / `cli` / `mcp` / `widget`)。
    /// 名乗らなかった行と、この語彙を知らない版が書いた行では `None`。
    pub source: Option<String>,
}

/// 行末 JSON をそのまま写したもの。`Context` は端末の状態だけを持つので、
/// 同じ括弧に入っている `s` はここで拾う。日ファイルの `d` は展開の時点で
/// 畳まれていて、外に出る行には残らない。
#[derive(Debug, Default, Deserialize)]
struct StoredEntry {
    #[serde(flatten)]
    context: Context,
    #[serde(default, rename = "s")]
    source: Option<String>,
}

/// 保存された行を [`TimelineEntry`] に戻す。
///
/// 読めない部分は本文に倒す。行末が JSON として壊れていても、時刻の括弧が
/// 無くても、書かれた文字は失わない。
#[must_use]
pub fn parse_timeline_entry(entry: &str) -> TimelineEntry {
    let time =
        timeline_entry_time(entry).and_then(|t| NaiveTime::parse_from_str(t, "%H:%M:%S").ok());
    let rest = split_time_prefix(entry).map_or(entry, |(_, rest)| rest);
    let stored = split_context_json(rest)
        .and_then(|json| serde_json::from_str::<StoredEntry>(json).ok())
        .unwrap_or_default();
    TimelineEntry {
        time,
        text: strip_timeline_prefix(entry).to_string(),
        context: stored.context,
        source: stored.source,
    }
}

pub fn format_note_markdown(
    body: &str,
    tags: &[String],
    timestamp: DateTime<Local>,
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<String, CoreError> {
    let time: DateTime<FixedOffset> = timestamp.into();
    let fm = NoteFrontmatter {
        tags: tags.to_vec(),
        context: Some(context.clone()),
        origin: provenance.origin.map(str::to_string),
        template: provenance.template.map(str::to_string),
        source: provenance.source.map(|s| s.as_str().to_string()),
        ..NoteFrontmatter::new(time)
    };
    frontmatter::render(&fm, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Location;
    use crate::utils::frontmatter::NoteFrontmatter;
    use chrono::TimeZone;

    fn fixed_timestamp() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 20, 14, 30, 45).unwrap()
    }

    fn test_context() -> Context {
        Context {
            battery: Some(82),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    #[test]
    fn test_format_timeline_line() {
        let result = format_timeline_line("hello world", fixed_timestamp(), &test_context());
        assert!(result.starts_with("- [14:30:45] hello world "));
        assert!(result.contains("\"battery\":82"));
        assert!(result.contains("\"is_charging\":false"));
    }

    #[test]
    fn test_format_timeline_line_empty_context() {
        let ctx = Context::default();
        let result = format_timeline_line("text", fixed_timestamp(), &ctx);
        assert_eq!(result, "- [14:30:45] text");
    }

    #[test]
    fn test_format_timeline_line_multiline() {
        let result = format_timeline_line("line1\nline2", fixed_timestamp(), &test_context());
        assert!(result.contains("line1\nline2"));
    }

    #[test]
    fn test_timeline_entry_time() {
        let line = format_timeline_line("hello", fixed_timestamp(), &test_context());
        assert_eq!(timeline_entry_time(&line), Some("14:30:45"));
    }

    /// 時刻を持たない旧い行。落として扱う側に判断させる。
    #[test]
    fn test_timeline_entry_time_without_prefix() {
        assert_eq!(timeline_entry_time("- plain bullet"), None);
    }

    /// 括弧の中は `HH:MM:SS` の 8 文字だけを時刻と見る。本文が `- [` で
    /// 始まる普通の箇条書き(`- [x] done` など)を時刻と取り違えない。
    #[test]
    fn a_time_prefix_is_exactly_eight_digits_and_colons() {
        assert_eq!(
            split_time_prefix("- [09:00:00] x"),
            Some(("- [09:00:00] ", "x"))
        );
        assert_eq!(split_time_prefix("- [9:00:00] x"), None);
        assert_eq!(split_time_prefix("- [09:00:000] x"), None);
        assert_eq!(split_time_prefix("- [aa:bb:cc] x"), None);
    }

    #[test]
    fn test_format_note_markdown() {
        let tags = vec!["rust".to_string(), "memo".to_string()];
        let result = format_note_markdown(
            "# Hello\nWorld",
            &tags,
            fixed_timestamp(),
            &test_context(),
            Provenance::default(),
        )
        .unwrap();

        let (fm, body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        assert_eq!(fm.tags, vec!["rust", "memo"]);
        assert!(fm.context.is_some());
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_format_note_markdown_empty_tags() {
        let result = format_note_markdown(
            "body",
            &[],
            fixed_timestamp(),
            &test_context(),
            Provenance::default(),
        )
        .unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn test_format_note_markdown_charging() {
        let ctx = Context {
            battery: Some(100),
            is_charging: Some(true),
            ..Context::default()
        };
        let result =
            format_note_markdown("body", &[], fixed_timestamp(), &ctx, Provenance::default())
                .unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        let context = fm.context.unwrap();
        assert_eq!(context.battery, Some(100));
        assert_eq!(context.is_charging, Some(true));
    }
    #[test]
    fn a_line_parses_back_into_time_text_and_context() {
        let ctx = Context {
            battery: Some(82),
            location: Some(Location {
                latitude: 35.6762,
                longitude: 139.6503,
            }),
            os: "macos".to_string(),
            ..Context::default()
        };
        let line = format_timeline_line("hello world", fixed_timestamp(), &ctx);

        let entry = parse_timeline_entry(&line);

        assert_eq!(entry.time, NaiveTime::from_hms_opt(14, 30, 45));
        assert_eq!(entry.text, "hello world");
        assert_eq!(entry.context, ctx);
    }

    /// 行末の `s` は端末の状態ではないので `Context` には入らない。
    /// それでも読む側は「どこから来た記録か」を知りたい。
    #[test]
    fn a_line_reports_the_source_that_wrote_it() {
        let entry = parse_timeline_entry("- [09:00:00] tapped {\"battery\":30,\"s\":\"widget\"}");

        assert_eq!(entry.text, "tapped");
        assert_eq!(entry.source.as_deref(), Some("widget"));
        assert_eq!(entry.context.battery, Some(30));
    }

    /// 名乗っていない行(この語彙より前に書かれたもの)は空欄のまま。
    #[test]
    fn a_line_without_a_source_reports_none() {
        let entry = parse_timeline_entry("- [09:00:00] typed {\"battery\":30}");

        assert_eq!(entry.source, None);
    }

    /// 時刻もコンテキストも持たない旧い行。本文だけは落とさない。
    #[test]
    fn a_bare_line_is_all_text() {
        let entry = parse_timeline_entry("- plain bullet");

        assert_eq!(entry.time, None);
        assert_eq!(entry.text, "- plain bullet");
        assert_eq!(entry.context, Context::default());
    }

    #[test]
    fn a_multiline_entry_keeps_its_newlines() {
        let line = format_timeline_line("line1\nline2", fixed_timestamp(), &Context::default());

        let entry = parse_timeline_entry(&line);

        assert_eq!(entry.text, "line1\nline2");
    }

    /// 本文が `{` で終わる JSON 風の文だと、末尾がコンテキストと紛れる。
    /// 読めない JSON は本文のまま残す。
    #[test]
    fn a_trailing_brace_in_the_text_is_not_a_context() {
        let entry = parse_timeline_entry("- [09:00:00] fn main() {");

        assert_eq!(entry.text, "fn main() {");
        assert_eq!(entry.context, Context::default());
    }
}
