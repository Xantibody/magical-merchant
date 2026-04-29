use chrono::{DateTime, FixedOffset};
use serde::Serialize;

use crate::utils::frontmatter::ProjectFrontmatter;

use super::task::TaskSummary;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub slug: String,
    pub name: String,
    pub created: DateTime<FixedOffset>,
    pub description: String,
    pub active_task_count: usize,
}

impl ProjectSummary {
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
pub struct ProjectActivitySummary {
    pub slug: String,
    pub name: String,
    pub completed_tasks: Vec<TaskSummary>,
    pub active_task_count: usize,
}
