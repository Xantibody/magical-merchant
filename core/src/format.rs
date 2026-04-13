use chrono::{DateTime, FixedOffset, Local};
use serde::Serialize;

use crate::error::CoreError;
use crate::frontmatter::{self, ContextMeta, NoteFrontmatter};

#[derive(Debug, Clone, Serialize)]
pub struct DeviceContext {
    pub battery: u8,
    pub is_charging: bool,
}

impl DeviceContext {
    pub fn mock() -> Self {
        Self {
            battery: 50,
            is_charging: false,
        }
    }
}

pub fn format_timeline_line(
    text: &str,
    timestamp: DateTime<Local>,
    context: &DeviceContext,
) -> String {
    let time = timestamp.format("%H:%M:%S");
    format!(
        "- [{time}] {text} {{ \"battery\": {battery}, \"is_charging\": {is_charging} }}",
        battery = context.battery,
        is_charging = context.is_charging,
    )
}

pub fn format_note_markdown(
    body: &str,
    tags: &[String],
    timestamp: DateTime<Local>,
    context: &DeviceContext,
) -> Result<String, CoreError> {
    let time: DateTime<FixedOffset> = timestamp.into();
    let fm = NoteFrontmatter {
        time,
        tags: tags.to_vec(),
        context: Some(ContextMeta {
            battery: context.battery,
            is_charging: context.is_charging,
        }),
    };
    frontmatter::render(&fm, body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::NoteFrontmatter;
    use chrono::TimeZone;

    fn fixed_timestamp() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 3, 20, 14, 30, 45).unwrap()
    }

    fn test_context() -> DeviceContext {
        DeviceContext {
            battery: 82,
            is_charging: false,
        }
    }

    #[test]
    fn test_device_context_mock() {
        let ctx = DeviceContext::mock();
        assert_eq!(ctx.battery, 50);
        assert!(!ctx.is_charging);
    }

    #[test]
    fn test_format_timeline_line() {
        let result = format_timeline_line("hello world", fixed_timestamp(), &test_context());
        assert_eq!(
            result,
            "- [14:30:45] hello world { \"battery\": 82, \"is_charging\": false }"
        );
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
        assert_eq!(ctx.battery, 82);
        assert!(!ctx.is_charging);
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_format_note_markdown_empty_tags() {
        let result =
            format_note_markdown("body", &[], fixed_timestamp(), &test_context()).unwrap();
        let (fm, _body): (NoteFrontmatter, String) = frontmatter::parse(&result).unwrap();
        assert!(fm.tags.is_empty());
    }

    #[test]
    fn test_format_note_markdown_charging() {
        let ctx = DeviceContext {
            battery: 100,
            is_charging: true,
        };
        let result = format_note_markdown("body", &[], fixed_timestamp(), &ctx).unwrap();
        let (fm, _body): (NoteFrontmatter, String) = frontmatter::parse(&result).unwrap();
        let context = fm.context.unwrap();
        assert_eq!(context.battery, 100);
        assert!(context.is_charging);
    }
}
