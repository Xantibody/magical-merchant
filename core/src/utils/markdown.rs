use chrono::{DateTime, FixedOffset, Local};
use serde::Serialize;
use serde::de::IgnoredAny;

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter};

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

pub fn format_note_markdown(
    body: &str,
    tags: &[String],
    timestamp: DateTime<Local>,
    context: &Context,
) -> Result<String, CoreError> {
    let time: DateTime<FixedOffset> = timestamp.into();
    let fm = NoteFrontmatter {
        time,
        tags: tags.to_vec(),
        context: Some(context.clone()),
        view: None,
    };
    frontmatter::render(&fm, body)
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn test_format_note_markdown() {
        let tags = vec!["rust".to_string(), "memo".to_string()];
        let result =
            format_note_markdown("# Hello\nWorld", &tags, fixed_timestamp(), &test_context())
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
        let result = format_note_markdown("body", &[], fixed_timestamp(), &test_context()).unwrap();
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
        let result = format_note_markdown("body", &[], fixed_timestamp(), &ctx).unwrap();
        let (fm, _body): (NoteFrontmatter, &str) = frontmatter::parse(&result).unwrap();
        let context = fm.context.unwrap();
        assert_eq!(context.battery, Some(100));
        assert_eq!(context.is_charging, Some(true));
    }
}
