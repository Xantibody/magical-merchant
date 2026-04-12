use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub slug: String,
    pub name: String,
    pub created: String,
    pub description: String,
    pub active_task_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskSummary {
    pub filename: String,
    pub title: String,
    pub created: String,
    pub completed: Option<String>,
    pub tags: Vec<String>,
    pub body: String,
}
