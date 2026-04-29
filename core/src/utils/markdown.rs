use chrono::{DateTime, FixedOffset, Local};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter};

pub fn format_timeline_line(text: &str, timestamp: DateTime<Local>, context: &Context) -> String {
    let time = timestamp.format("%H:%M:%S");
    let context_json = serde_json::to_string(context).unwrap_or_default();
    format!("- [{time}] {text} {context_json}")
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
            network_type: None,
            wifi_ssid: None,
            location: None,
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
    fn test_format_timeline_line_none_fields() {
        let ctx = Context {
            battery: None,
            is_charging: None,
            network_type: None,
            wifi_ssid: None,
            location: None,
        };
        let result = format_timeline_line("text", fixed_timestamp(), &ctx);
        assert!(result.starts_with("- [14:30:45] text "));
        assert!(!result.contains("battery"));
    }

    #[test]
    fn test_format_timeline_line_multiline() {
        let result = format_timeline_line("line1\nline2", fixed_timestamp(), &test_context());
        assert!(result.contains("line1\nline2"));
    }

    #[test]
    fn test_format_note_markdown() {
        let tags = vec!["rust".to_string(), "memo".to_string()];
        let result =
            format_note_markdown("# Hello\nWorld", &tags, fixed_timestamp(), &test_context())
                .unwrap();

        let (fm, body): (NoteFrontmatter, String) = frontmatter::parse(&result).unwrap();
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
        let (fm, _body): (NoteFrontmatter, String) = frontmatter::parse(&result).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn test_format_note_markdown_charging() {
        let ctx = Context {
            battery: Some(100),
            is_charging: Some(true),
            network_type: None,
            wifi_ssid: None,
            location: None,
        };
        let result = format_note_markdown("body", &[], fixed_timestamp(), &ctx).unwrap();
        let (fm, _body): (NoteFrontmatter, String) = frontmatter::parse(&result).unwrap();
        let context = fm.context.unwrap();
        assert_eq!(context.battery, Some(100));
        assert_eq!(context.is_charging, Some(true));
    }
}
