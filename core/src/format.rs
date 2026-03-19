use chrono::{DateTime, Local};
use serde::Serialize;

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
) -> String {
    let time_str = timestamp.format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let tags_str = tags
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "---\ntime: \"{time_str}\"\ntags: [{tags_str}]\ncontext:\n  battery: {battery}\n  is_charging: {is_charging}\n---\n{body}",
        battery = context.battery,
        is_charging = context.is_charging,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
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
            format_note_markdown("# Hello\nWorld", &tags, fixed_timestamp(), &test_context());

        assert!(result.starts_with("---\n"));
        assert!(result.contains("time: \"2026-03-20T14:30:45"));
        assert!(result.contains("tags: [\"rust\", \"memo\"]"));
        assert!(result.contains("battery: 82"));
        assert!(result.contains("is_charging: false"));
        assert!(result.ends_with("---\n# Hello\nWorld"));
    }

    #[test]
    fn test_format_note_markdown_empty_tags() {
        let result = format_note_markdown("body", &[], fixed_timestamp(), &test_context());
        assert!(result.contains("tags: []"));
    }

    #[test]
    fn test_format_note_markdown_charging() {
        let ctx = DeviceContext {
            battery: 100,
            is_charging: true,
        };
        let result = format_note_markdown("body", &[], fixed_timestamp(), &ctx);
        assert!(result.contains("battery: 100"));
        assert!(result.contains("is_charging: true"));
    }
}
