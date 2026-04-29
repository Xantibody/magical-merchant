use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::error::CoreError;
use crate::utils::frontmatter::{self, TaskFrontmatter};

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub filename: String,
    pub title: String,
    pub created: DateTime<FixedOffset>,
    pub completed: Option<DateTime<FixedOffset>>,
    pub tags: Vec<String>,
    pub body: String,
}

impl Summary {
    pub fn from_content(filename: &str, content: &str) -> Result<Self, CoreError> {
        let (fm, body): (TaskFrontmatter, String) = frontmatter::parse(content)?;
        Ok(Self {
            filename: filename.to_string(),
            title: fm.title,
            created: fm.created,
            completed: fm.completed,
            tags: fm.tags,
            body,
        })
    }

    pub fn to_frontmatter(&self) -> TaskFrontmatter {
        TaskFrontmatter {
            title: self.title.clone(),
            created: self.created,
            completed: self.completed,
            tags: self.tags.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};

    fn sample_datetime() -> DateTime<FixedOffset> {
        FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 1, 1, 12, 0, 0)
            .unwrap()
    }

    #[test]
    fn test_from_content() {
        let fm = TaskFrontmatter {
            title: "My Task".to_string(),
            created: sample_datetime(),
            completed: None,
            tags: vec!["rust".to_string()],
        };
        let content = frontmatter::render(&fm, "task body").unwrap();
        let task = Summary::from_content("test.md", &content).unwrap();
        assert_eq!(task.filename, "test.md");
        assert_eq!(task.title, "My Task");
        assert_eq!(task.tags, vec!["rust"]);
        assert_eq!(task.body, "task body");
        assert!(task.completed.is_none());
    }

    #[test]
    fn test_to_frontmatter() {
        let task = Summary {
            filename: "test.md".to_string(),
            title: "Task".to_string(),
            created: sample_datetime(),
            completed: Some(sample_datetime()),
            tags: vec!["done".to_string()],
            body: "body".to_string(),
        };
        let fm = task.to_frontmatter();
        assert_eq!(fm.title, "Task");
        assert_eq!(fm.created, sample_datetime());
        assert!(fm.completed.is_some());
        assert_eq!(fm.tags, vec!["done"]);
    }
}
