use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::utils::frontmatter::ProjectFrontmatter;

use super::task;

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub slug: String,
    pub name: String,
    pub created: DateTime<FixedOffset>,
    pub description: String,
    pub active_task_count: usize,
}

impl Summary {
    pub fn from_frontmatter(
        slug: String,
        fm: ProjectFrontmatter,
        active_task_count: usize,
    ) -> Self {
        Self {
            slug,
            name: fm.name,
            created: fm.created,
            description: fm.description,
            active_task_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivitySummary {
    pub slug: String,
    pub name: String,
    pub completed_tasks: Vec<task::Summary>,
    pub active_task_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};

    fn sample_frontmatter() -> ProjectFrontmatter {
        ProjectFrontmatter {
            name: "My Project".to_string(),
            created: FixedOffset::east_opt(9 * 3600)
                .unwrap()
                .with_ymd_and_hms(2026, 1, 1, 12, 0, 0)
                .unwrap(),
            description: "A test project".to_string(),
        }
    }

    #[test]
    fn test_from_frontmatter() {
        let fm = sample_frontmatter();
        let created = fm.created;
        let summary = Summary::from_frontmatter("my-proj".to_string(), fm, 3);

        assert_eq!(summary.slug, "my-proj");
        assert_eq!(summary.name, "My Project");
        assert_eq!(summary.created, created);
        assert_eq!(summary.description, "A test project");
        assert_eq!(summary.active_task_count, 3);
    }

    #[test]
    fn test_from_frontmatter_zero_tasks() {
        let fm = sample_frontmatter();
        let summary = Summary::from_frontmatter("empty".to_string(), fm, 0);

        assert_eq!(summary.active_task_count, 0);
    }
}
