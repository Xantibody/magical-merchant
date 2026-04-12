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

fn format_task_md(title: &str, tags: &[String], created: &str, body: &str) -> String {
    let tags_str = tags
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("---\ntitle: \"{title}\"\ncreated: \"{created}\"\ntags: [{tags_str}]\n---\n{body}")
}

fn format_completed_task_md(
    title: &str,
    tags: &[String],
    created: &str,
    completed: &str,
    body: &str,
) -> String {
    let tags_str = tags
        .iter()
        .map(|t| format!("\"{t}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("---\ntitle: \"{title}\"\ncreated: \"{created}\"\ncompleted: \"{completed}\"\ntags: [{tags_str}]\n---\n{body}")
}

fn parse_task_frontmatter(content: &str) -> TaskSummary {
    let mut title = String::new();
    let mut created = String::new();
    let mut completed = None;
    let mut tags = Vec::new();
    let mut body = content.to_string();

    if let Some(stripped) = content.strip_prefix("---\n") {
        if let Some(end) = stripped.find("\n---\n") {
            let frontmatter = &stripped[..end];
            body = stripped[end + 5..].to_string();

            for line in frontmatter.lines() {
                if let Some(v) = line.strip_prefix("title: ") {
                    title = v.trim_matches('"').to_string();
                } else if let Some(v) = line.strip_prefix("created: ") {
                    created = v.trim_matches('"').to_string();
                } else if let Some(v) = line.strip_prefix("completed: ") {
                    completed = Some(v.trim_matches('"').to_string());
                } else if let Some(v) = line.strip_prefix("tags: [") {
                    let v = v.trim_end_matches(']');
                    tags = v
                        .split(", ")
                        .map(|s| s.trim_matches('"').to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
        }
    }

    TaskSummary {
        filename: String::new(),
        title,
        created,
        completed,
        tags,
        body,
    }
}

pub fn create_task(
    base_dir: &Path,
    project_slug: &str,
    title: &str,
    tags: &[String],
    body: &str,
) -> Result<PathBuf, CoreError> {
    let active_dir = path::active_tasks_dir(base_dir, project_slug);
    if !active_dir.exists() {
        return Err(CoreError::NotFound(format!(
            "project: {project_slug}"
        )));
    }

    let now = Local::now();
    let filename = format!("{}.md", now.format("%Y%m%d_%H%M%S"));
    let file_path = active_dir.join(&filename);
    let created = now.format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let content = format_task_md(title, tags, &created, body);
    fs::write(&file_path, content)?;

    Ok(file_path)
}

fn list_tasks_in_dir(dir: &Path) -> Result<Vec<TaskSummary>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "md"))
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));

    let tasks = entries
        .into_iter()
        .map(|entry| {
            let filename = entry.file_name().to_string_lossy().to_string();
            let content = fs::read_to_string(entry.path()).unwrap_or_default();
            let mut task = parse_task_frontmatter(&content);
            task.filename = filename;
            task
        })
        .collect();

    Ok(tasks)
}

pub fn list_active_tasks(
    base_dir: &Path,
    project_slug: &str,
) -> Result<Vec<TaskSummary>, CoreError> {
    list_tasks_in_dir(&path::active_tasks_dir(base_dir, project_slug))
}

pub fn list_done_tasks(
    base_dir: &Path,
    project_slug: &str,
) -> Result<Vec<TaskSummary>, CoreError> {
    list_tasks_in_dir(&path::done_tasks_dir(base_dir, project_slug))
}

pub fn complete_task(
    base_dir: &Path,
    project_slug: &str,
    filename: &str,
) -> Result<(), CoreError> {
    let active_path = path::active_tasks_dir(base_dir, project_slug).join(filename);
    if !active_path.exists() {
        return Err(CoreError::NotFound(format!(
            "task: {project_slug}/{filename}"
        )));
    }

    let content = fs::read_to_string(&active_path)?;
    let task = parse_task_frontmatter(&content);

    let now = Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let new_content =
        format_completed_task_md(&task.title, &task.tags, &task.created, &now, &task.body);

    let done_path = path::done_tasks_dir(base_dir, project_slug).join(filename);
    fs::write(&done_path, new_content)?;
    fs::remove_file(&active_path)?;

    Ok(())
}

pub fn update_task(
    base_dir: &Path,
    project_slug: &str,
    filename: &str,
    title: &str,
    tags: &[String],
    body: &str,
) -> Result<(), CoreError> {
    let active_path = path::active_tasks_dir(base_dir, project_slug).join(filename);
    if !active_path.exists() {
        return Err(CoreError::NotFound(format!(
            "task: {project_slug}/{filename}"
        )));
    }

    let content = fs::read_to_string(&active_path)?;
    let task = parse_task_frontmatter(&content);
    let new_content = format_task_md(title, tags, &task.created, body);
    fs::write(&active_path, new_content)?;

    Ok(())
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

    #[test]
    fn test_create_task() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let tags = vec!["rust".to_string(), "test".to_string()];
        let path = create_task(tmp.path(), "proj", "My Task", &tags, "Task body").unwrap();
        assert!(path.exists());

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("title: \"My Task\""));
        assert!(content.contains("tags: [\"rust\", \"test\"]"));
        assert!(content.contains("Task body"));
    }

    #[test]
    fn test_create_task_nonexistent_project() {
        let tmp = TempDir::new().unwrap();
        let result = create_task(tmp.path(), "nonexistent", "Task", &[], "body");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_list_active_tasks_empty() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let tasks = list_active_tasks(tmp.path(), "proj").unwrap();
        assert!(tasks.is_empty());
    }

    #[test]
    fn test_list_active_tasks_multiple() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        // Create tasks with different filenames by writing directly
        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        fs::write(
            active_dir.join("20260101_120000.md"),
            "---\ntitle: \"First\"\ncreated: \"2026-01-01\"\ntags: []\n---\nbody1",
        )
        .unwrap();
        fs::write(
            active_dir.join("20260102_120000.md"),
            "---\ntitle: \"Second\"\ncreated: \"2026-01-02\"\ntags: []\n---\nbody2",
        )
        .unwrap();

        let tasks = list_active_tasks(tmp.path(), "proj").unwrap();
        assert_eq!(tasks.len(), 2);
        // Reverse sorted, so newer first
        assert_eq!(tasks[0].title, "Second");
        assert_eq!(tasks[1].title, "First");
    }

    #[test]
    fn test_complete_task() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        let filename = "20260101_120000.md";
        fs::write(
            active_dir.join(filename),
            "---\ntitle: \"Task\"\ncreated: \"2026-01-01T12:00:00+09:00\"\ntags: [\"a\"]\n---\nbody",
        )
        .unwrap();

        complete_task(tmp.path(), "proj", filename).unwrap();

        // Active file should be gone
        assert!(!active_dir.join(filename).exists());

        // Done file should exist with completed field
        let done_path = path::done_tasks_dir(tmp.path(), "proj").join(filename);
        assert!(done_path.exists());
        let content = fs::read_to_string(&done_path).unwrap();
        assert!(content.contains("completed: \""));
        assert!(content.contains("title: \"Task\""));
        assert!(content.contains("tags: [\"a\"]"));
        assert!(content.contains("body"));
    }

    #[test]
    fn test_complete_task_not_found() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let result = complete_task(tmp.path(), "proj", "nonexistent.md");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_update_task() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        let filename = "20260101_120000.md";
        fs::write(
            active_dir.join(filename),
            "---\ntitle: \"Old\"\ncreated: \"2026-01-01T12:00:00+09:00\"\ntags: []\n---\nold body",
        )
        .unwrap();

        let new_tags = vec!["updated".to_string()];
        update_task(tmp.path(), "proj", filename, "New Title", &new_tags, "new body").unwrap();

        let content = fs::read_to_string(active_dir.join(filename)).unwrap();
        assert!(content.contains("title: \"New Title\""));
        assert!(content.contains("tags: [\"updated\"]"));
        assert!(content.contains("new body"));
        // Preserve original created timestamp
        assert!(content.contains("created: \"2026-01-01T12:00:00+09:00\""));
    }

    #[test]
    fn test_read_project_with_active_tasks() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        fs::write(
            active_dir.join("20260101_120000.md"),
            "---\ntitle: \"T\"\ncreated: \"2026\"\ntags: []\n---\n",
        )
        .unwrap();

        let summary = read_project(tmp.path(), "proj").unwrap();
        assert_eq!(summary.active_task_count, 1);
    }
}
