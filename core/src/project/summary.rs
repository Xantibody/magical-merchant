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
