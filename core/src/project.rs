use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;

use crate::error::CoreError;
use crate::path;

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

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

fn format_project_md(name: &str, description: &str, created: &str) -> String {
    format!(
        "---\nname: \"{name}\"\ncreated: \"{created}\"\ndescription: \"{description}\"\n---\n"
    )
}

fn parse_project_frontmatter(content: &str) -> (String, String, String) {
    let mut name = String::new();
    let mut created = String::new();
    let mut description = String::new();

    if let Some(stripped) = content.strip_prefix("---\n") {
        if let Some(end) = stripped.find("\n---") {
            let frontmatter = &stripped[..end];
            for line in frontmatter.lines() {
                if let Some(v) = line.strip_prefix("name: ") {
                    name = v.trim_matches('"').to_string();
                } else if let Some(v) = line.strip_prefix("created: ") {
                    created = v.trim_matches('"').to_string();
                } else if let Some(v) = line.strip_prefix("description: ") {
                    description = v.trim_matches('"').to_string();
                }
            }
        }
    }

    (name, created, description)
}

pub fn create_project(
    base_dir: &Path,
    slug: &str,
    name: &str,
    description: &str,
) -> Result<PathBuf, CoreError> {
    if !is_valid_slug(slug) {
        return Err(CoreError::InvalidSlug(slug.to_string()));
    }

    let proj_dir = path::project_dir(base_dir, slug);
    fs::create_dir_all(path::active_tasks_dir(base_dir, slug))?;
    fs::create_dir_all(path::done_tasks_dir(base_dir, slug))?;

    let now = Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let content = format_project_md(name, description, &now);
    let file_path = path::project_file_path(base_dir, slug);
    fs::write(&file_path, content)?;

    Ok(proj_dir)
}

pub fn list_projects(base_dir: &Path) -> Result<Vec<ProjectSummary>, CoreError> {
    let dir = path::projects_dir(base_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut projects = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let slug = entry.file_name().to_string_lossy().to_string();
        if let Ok(summary) = read_project(base_dir, &slug) {
            projects.push(summary);
        }
    }

    Ok(projects)
}

pub fn read_project(base_dir: &Path, slug: &str) -> Result<ProjectSummary, CoreError> {
    let file_path = path::project_file_path(base_dir, slug);
    if !file_path.exists() {
        return Err(CoreError::NotFound(format!("project: {slug}")));
    }

    let content = fs::read_to_string(&file_path)?;
    let (name, created, description) = parse_project_frontmatter(&content);

    let active_dir = path::active_tasks_dir(base_dir, slug);
    let active_task_count = if active_dir.exists() {
        fs::read_dir(&active_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
            .count()
    } else {
        0
    };

    Ok(ProjectSummary {
        slug: slug.to_string(),
        name,
        created,
        description,
        active_task_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_is_valid_slug() {
        assert!(is_valid_slug("my-project"));
        assert!(is_valid_slug("project123"));
        assert!(is_valid_slug("a"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("My-Project"));
        assert!(!is_valid_slug("-start"));
        assert!(!is_valid_slug("end-"));
        assert!(!is_valid_slug("has space"));
        assert!(!is_valid_slug("under_score"));
    }

    #[test]
    fn test_create_project() {
        let tmp = TempDir::new().unwrap();
        let result = create_project(tmp.path(), "my-proj", "My Project", "A test project");
        assert!(result.is_ok());

        let proj_dir = result.unwrap();
        assert!(proj_dir.exists());
        assert!(path::project_file_path(tmp.path(), "my-proj").exists());
        assert!(path::active_tasks_dir(tmp.path(), "my-proj").exists());
        assert!(path::done_tasks_dir(tmp.path(), "my-proj").exists());

        let content =
            fs::read_to_string(path::project_file_path(tmp.path(), "my-proj")).unwrap();
        assert!(content.contains("name: \"My Project\""));
        assert!(content.contains("description: \"A test project\""));
    }

    #[test]
    fn test_create_project_invalid_slug() {
        let tmp = TempDir::new().unwrap();
        let result = create_project(tmp.path(), "Bad Slug", "Name", "Desc");
        assert!(matches!(result, Err(CoreError::InvalidSlug(_))));
    }

    #[test]
    fn test_list_projects_empty() {
        let tmp = TempDir::new().unwrap();
        let projects = list_projects(tmp.path()).unwrap();
        assert!(projects.is_empty());
    }

    #[test]
    fn test_list_projects_multiple() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "alpha", "Alpha", "First").unwrap();
        create_project(tmp.path(), "beta", "Beta", "Second").unwrap();

        let projects = list_projects(tmp.path()).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].slug, "alpha");
        assert_eq!(projects[1].slug, "beta");
    }

    #[test]
    fn test_read_project() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "test-proj", "Test", "Desc").unwrap();

        let summary = read_project(tmp.path(), "test-proj").unwrap();
        assert_eq!(summary.slug, "test-proj");
        assert_eq!(summary.name, "Test");
        assert_eq!(summary.description, "Desc");
        assert_eq!(summary.active_task_count, 0);
    }

    #[test]
    fn test_read_project_not_found() {
        let tmp = TempDir::new().unwrap();
        let result = read_project(tmp.path(), "nonexistent");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
