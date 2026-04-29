use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::error::CoreError;
use crate::utils::device::Context;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteFrontmatter {
    pub time: DateTime<FixedOffset>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Context>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectFrontmatter {
    pub name: String,
    pub created: DateTime<FixedOffset>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskFrontmatter {
    pub title: String,
    pub created: DateTime<FixedOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed: Option<DateTime<FixedOffset>>,
    #[serde(default)]
    pub tags: Vec<String>,
}

pub fn render<T: Serialize>(fm: &T, body: &str) -> Result<String, CoreError> {
    let yaml = serde_yaml::to_string(fm).map_err(|e| CoreError::Parse(e.to_string()))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

pub fn parse<T: DeserializeOwned>(content: &str) -> Result<(T, String), CoreError> {
    let (fm, body) = markdown_frontmatter::parse::<T>(content)
        .map_err(|e| CoreError::Parse(format!("{e:?}")))?;
    Ok((fm, body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn fixed_offset() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn sample_datetime() -> DateTime<FixedOffset> {
        fixed_offset()
            .with_ymd_and_hms(2026, 3, 20, 14, 30, 45)
            .unwrap()
    }

    #[test]
    fn test_project_frontmatter_roundtrip() {
        let fm = ProjectFrontmatter {
            name: "My Project".to_string(),
            created: sample_datetime(),
            description: "A test project".to_string(),
        };
        let rendered = render(&fm, "").unwrap();
        let (parsed, body): (ProjectFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "");
    }

    #[test]
    fn test_task_frontmatter_roundtrip() {
        let fm = TaskFrontmatter {
            title: "My Task".to_string(),
            created: sample_datetime(),
            completed: None,
            tags: vec!["rust".to_string(), "test".to_string()],
        };
        let rendered = render(&fm, "Task body here").unwrap();
        let (parsed, body): (TaskFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "Task body here");
    }

    #[test]
    fn test_task_frontmatter_with_completed_roundtrip() {
        let fm = TaskFrontmatter {
            title: "Done Task".to_string(),
            created: sample_datetime(),
            completed: Some(sample_datetime()),
            tags: vec![],
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, body): (TaskFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "body");
    }

    #[test]
    fn test_note_frontmatter_roundtrip() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec!["memo".to_string()],
            context: Some(Context {
                battery: Some(82),
                is_charging: Some(false),
                network_type: None,
                wifi_ssid: None,
                location: None,
            }),
        };
        let rendered = render(&fm, "# Hello\nWorld").unwrap();
        let (parsed, body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
        assert_eq!(body, "# Hello\nWorld");
    }

    #[test]
    fn test_note_frontmatter_no_context() {
        let fm = NoteFrontmatter {
            time: sample_datetime(),
            tags: vec![],
            context: None,
        };
        let rendered = render(&fm, "body").unwrap();
        let (parsed, _body): (NoteFrontmatter, _) = parse(&rendered).unwrap();
        assert_eq!(parsed, fm);
    }

    #[test]
    fn test_render_contains_delimiters() {
        let fm = ProjectFrontmatter {
            name: "Test".to_string(),
            created: sample_datetime(),
            description: "Desc".to_string(),
        };
        let rendered = render(&fm, "body").unwrap();
        assert!(rendered.starts_with("---\n"));
        assert!(rendered.contains("\n---\n"));
        assert!(rendered.ends_with("body"));
    }

    #[test]
    fn test_note_frontmatter_old_format_compat() {
        // Old format only had battery and is_charging
        let yaml = "---\ntime: 2026-03-20T14:30:45+09:00\ntags: []\ncontext:\n  battery: 82\n  is_charging: false\n---\nbody";
        let (fm, body): (NoteFrontmatter, String) = parse(yaml).unwrap();
        let ctx = fm.context.unwrap();
        assert_eq!(ctx.battery, Some(82));
        assert_eq!(ctx.is_charging, Some(false));
        assert_eq!(ctx.network_type, None);
        assert_eq!(body, "body");
    }
}
