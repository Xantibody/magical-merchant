use chrono::{DateTime, FixedOffset, Local, NaiveTime};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};

/// What goes at the end of the line is not always `Context` itself. A day file
/// writes the reduced form with the device information pushed out to the head.
#[must_use]
pub fn format_scrawl_line<C: Serialize>(
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

/// Cuts `- [HH:MM:SS] ` out as the prefix.
pub(crate) fn split_time_prefix(entry: &str) -> Option<(&str, &str)> {
    let rest = entry.strip_prefix("- [")?;
    let close = rest.find("] ")?;
    let time = &rest[..close];
    if time.len() != 8 || !time.chars().all(|c| c.is_ascii_digit() || c == ':') {
        return None;
    }
    Some(entry.split_at("- [".len() + close + "] ".len()))
}

/// Returns the trailing context JSON (if what follows the last " {" is a JSON object).
pub(crate) fn split_context_json(rest: &str) -> Option<&str> {
    let start = rest.rfind(" {")?;
    let candidate = &rest[start + 1..];
    // no building a `Value` to check is_object: candidate always starts with `{`,
    // so if it passes as syntax it cannot be anything but a JSON object. `IgnoredAny`
    // only validates and allocates neither a Map nor a String.
    serde_json::from_str::<IgnoredAny>(candidate)
        .ok()
        .map(|_| candidate)
}

/// Removes the time prefix and the context recorded at the time, returning only the
/// text the user wrote.
#[must_use]
pub fn strip_scrawl_prefix(entry: &str) -> &str {
    let rest = split_time_prefix(entry).map_or(entry, |(_, rest)| rest);
    split_context_json(rest).map_or(rest, |json| rest[..rest.len() - json.len()].trim_end())
}

/// The entry's `HH:MM:SS`. `None` for an old line without the prefix.
#[must_use]
pub fn scrawl_entry_time(entry: &str) -> Option<&str> {
    let (prefix, _) = split_time_prefix(entry)?;
    prefix
        .strip_prefix("- [")
        .and_then(|t| t.strip_suffix("] "))
}

/// One line taken apart. The line's shape (the time brackets, the trailing JSON)
/// is hidden from the reader.
///
/// The screen can work with the line as is, but handing it outside (MCP) needs
/// values, not a format. What is matched is "when and where", not the position of `- [`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrawlEntry {
    /// The device's local time. `None` for an old line.
    pub time: Option<NaiveTime>,
    /// Only the text the writer typed.
    pub text: String,
    /// The device's state at the time of recording. The default if nothing remains.
    pub context: Context,
    /// Which entry point wrote it (`app` / `cli` / `mcp` / `widget`).
    /// `None` for a line that did not name one, and for a line written by a version
    /// that does not know this vocabulary.
    pub source: Option<String>,
}

/// A direct copy of the trailing JSON. `Context` holds only the device state, so
/// the `s` that shares the same braces is picked up here. The `d` of a day file is
/// folded away at expansion time and does not remain on a line that goes outside.
#[derive(Debug, Default, Deserialize)]
struct StoredEntry {
    #[serde(flatten)]
    context: Context,
    #[serde(default, rename = "s")]
    source: Option<String>,
}

/// Turns a stored line back into a [`ScrawlEntry`].
///
/// Whatever cannot be read falls back into the text. Even if the line end is
/// broken as JSON, or the time brackets are missing, the written characters are not lost.
#[must_use]
pub fn parse_scrawl_entry(entry: &str) -> ScrawlEntry {
    let time = scrawl_entry_time(entry).and_then(|t| NaiveTime::parse_from_str(t, "%H:%M:%S").ok());
    let rest = split_time_prefix(entry).map_or(entry, |(_, rest)| rest);
    let stored = split_context_json(rest)
        .and_then(|json| serde_json::from_str::<StoredEntry>(json).ok())
        .unwrap_or_default();
    ScrawlEntry {
        time,
        text: strip_scrawl_prefix(entry).to_string(),
        context: stored.context,
        source: stored.source,
    }
}

pub fn format_note_markdown(
    body: &str,
    tags: &[String],
    time: DateTime<FixedOffset>,
    context: &Context,
    provenance: Provenance<'_>,
) -> Result<String, CoreError> {
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
    fn test_format_scrawl_line() {
        let result = format_scrawl_line("hello world", fixed_timestamp(), &test_context());
        assert!(result.starts_with("- [14:30:45] hello world "));
        assert!(result.contains("\"battery\":82"));
        assert!(result.contains("\"is_charging\":false"));
    }

    #[test]
    fn test_format_scrawl_line_empty_context() {
        let ctx = Context::default();
        let result = format_scrawl_line("text", fixed_timestamp(), &ctx);
        assert_eq!(result, "- [14:30:45] text");
    }

    #[test]
    fn test_format_scrawl_line_multiline() {
        let result = format_scrawl_line("line1\nline2", fixed_timestamp(), &test_context());
        assert!(result.contains("line1\nline2"));
    }

    #[test]
    fn test_scrawl_entry_time() {
        let line = format_scrawl_line("hello", fixed_timestamp(), &test_context());
        assert_eq!(scrawl_entry_time(&line), Some("14:30:45"));
    }

    /// An old line without a time. Dropped, and the handling side decides.
    #[test]
    fn test_scrawl_entry_time_without_prefix() {
        assert_eq!(scrawl_entry_time("- plain bullet"), None);
    }

    /// Only the 8 characters of `HH:MM:SS` inside the brackets count as a time. An
    /// ordinary bullet whose text starts with `- [` (such as `- [x] done`) is not
    /// mistaken for a time.
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
            fixed_timestamp().fixed_offset(),
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
            fixed_timestamp().fixed_offset(),
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
        let result = format_note_markdown(
            "body",
            &[],
            fixed_timestamp().fixed_offset(),
            &ctx,
            Provenance::default(),
        )
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
        let line = format_scrawl_line("hello world", fixed_timestamp(), &ctx);

        let entry = parse_scrawl_entry(&line);

        assert_eq!(entry.time, NaiveTime::from_hms_opt(14, 30, 45));
        assert_eq!(entry.text, "hello world");
        assert_eq!(entry.context, ctx);
    }

    /// The trailing `s` is not device state, so it does not go into `Context`.
    /// The reader still wants to know "where this record came from".
    #[test]
    fn a_line_reports_the_source_that_wrote_it() {
        let entry = parse_scrawl_entry("- [09:00:00] tapped {\"battery\":30,\"s\":\"widget\"}");

        assert_eq!(entry.text, "tapped");
        assert_eq!(entry.source.as_deref(), Some("widget"));
        assert_eq!(entry.context.battery, Some(30));
    }

    /// A line that names no source (written before this vocabulary) stays blank.
    #[test]
    fn a_line_without_a_source_reports_none() {
        let entry = parse_scrawl_entry("- [09:00:00] typed {\"battery\":30}");

        assert_eq!(entry.source, None);
    }

    /// An old line with neither time nor context. The text alone is not dropped.
    #[test]
    fn a_bare_line_is_all_text() {
        let entry = parse_scrawl_entry("- plain bullet");

        assert_eq!(entry.time, None);
        assert_eq!(entry.text, "- plain bullet");
        assert_eq!(entry.context, Context::default());
    }

    #[test]
    fn a_multiline_entry_keeps_its_newlines() {
        let line = format_scrawl_line("line1\nline2", fixed_timestamp(), &Context::default());

        let entry = parse_scrawl_entry(&line);

        assert_eq!(entry.text, "line1\nline2");
    }

    /// A JSON-like text ending in `{` makes the tail look like a context.
    /// Unreadable JSON stays as text.
    #[test]
    fn a_trailing_brace_in_the_text_is_not_a_context() {
        let entry = parse_scrawl_entry("- [09:00:00] fn main() {");

        assert_eq!(entry.text, "fn main() {");
        assert_eq!(entry.context, Context::default());
    }
}
