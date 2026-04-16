use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local, NaiveDate};
use serde::Serialize;

use crate::error::CoreError;
use crate::frontmatter::{self, ProjectFrontmatter, TaskFrontmatter};
use crate::path;

#[derive(Debug, Clone, Serialize)]
pub struct ProjectSummary {
    pub slug: String,
    pub name: String,
    pub created: DateTime<FixedOffset>,
    pub description: String,
    pub active_task_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskSummary {
    pub filename: String,
    pub title: String,
    pub created: DateTime<FixedOffset>,
    pub completed: Option<DateTime<FixedOffset>>,
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

fn validate_filename(filename: &str) -> Result<(), CoreError> {
    if filename.contains('/')
        || filename.contains('\\')
        || filename.contains('\0')
        || filename.contains("..")
    {
        return Err(CoreError::PathTraversal(filename.to_string()));
    }
    Ok(())
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

    let file_path = path::project_file_path(base_dir, slug);
    if file_path.exists() {
        return Err(CoreError::AlreadyExists(format!("project: {slug}")));
    }

    let proj_dir = path::project_dir(base_dir, slug);
    fs::create_dir_all(path::active_tasks_dir(base_dir, slug))?;
    fs::create_dir_all(path::done_tasks_dir(base_dir, slug))?;

    let now: DateTime<FixedOffset> = Local::now().into();
    let fm = ProjectFrontmatter {
        name: name.to_string(),
        created: now,
        description: description.to_string(),
    };
    let content = frontmatter::render(&fm, "")?;
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

pub fn create_task(
    base_dir: &Path,
    project_slug: &str,
    title: &str,
    tags: &[String],
    body: &str,
) -> Result<PathBuf, CoreError> {
    let active_dir = path::active_tasks_dir(base_dir, project_slug);
    if !active_dir.exists() {
        return Err(CoreError::NotFound(format!("project: {project_slug}")));
    }

    let now: DateTime<FixedOffset> = Local::now().into();
    let filename = format!("{}.md", now.format("%Y%m%d_%H%M%S_%3f"));
    let file_path = active_dir.join(&filename);
    let fm = TaskFrontmatter {
        title: title.to_string(),
        created: now,
        completed: None,
        tags: tags.to_vec(),
    };
    let content = frontmatter::render(&fm, body)?;
    fs::write(&file_path, content)?;

    Ok(file_path)
}

fn parse_task_file(content: &str) -> Result<TaskSummary, CoreError> {
    let (fm, body): (TaskFrontmatter, String) = frontmatter::parse(content)?;
    Ok(TaskSummary {
        filename: String::new(),
        title: fm.title,
        created: fm.created,
        completed: fm.completed,
        tags: fm.tags,
        body,
    })
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

    let mut tasks = Vec::new();
    for entry in entries {
        let filename = entry.file_name().to_string_lossy().to_string();
        let content = fs::read_to_string(entry.path())?;
        let mut task = parse_task_file(&content)?;
        task.filename = filename;
        tasks.push(task);
    }

    Ok(tasks)
}

pub fn list_active_tasks(
    base_dir: &Path,
    project_slug: &str,
) -> Result<Vec<TaskSummary>, CoreError> {
    let project_file = path::project_file_path(base_dir, project_slug);
    if !project_file.exists() {
        return Err(CoreError::NotFound(format!("project: {project_slug}")));
    }
    list_tasks_in_dir(&path::active_tasks_dir(base_dir, project_slug))
}

pub fn list_done_tasks(base_dir: &Path, project_slug: &str) -> Result<Vec<TaskSummary>, CoreError> {
    let project_file = path::project_file_path(base_dir, project_slug);
    if !project_file.exists() {
        return Err(CoreError::NotFound(format!("project: {project_slug}")));
    }
    list_tasks_in_dir(&path::done_tasks_dir(base_dir, project_slug))
}

pub fn complete_task(base_dir: &Path, project_slug: &str, filename: &str) -> Result<(), CoreError> {
    validate_filename(filename)?;
    let active_path = path::active_tasks_dir(base_dir, project_slug).join(filename);
    if !active_path.exists() {
        return Err(CoreError::NotFound(format!(
            "task: {project_slug}/{filename}"
        )));
    }

    let content = fs::read_to_string(&active_path)?;
    let task = parse_task_file(&content)?;

    let now: DateTime<FixedOffset> = Local::now().into();
    let fm = TaskFrontmatter {
        title: task.title,
        created: task.created,
        completed: Some(now),
        tags: task.tags,
    };
    let new_content = frontmatter::render(&fm, &task.body)?;

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
    validate_filename(filename)?;
    let active_path = path::active_tasks_dir(base_dir, project_slug).join(filename);
    if !active_path.exists() {
        return Err(CoreError::NotFound(format!(
            "task: {project_slug}/{filename}"
        )));
    }

    let content = fs::read_to_string(&active_path)?;
    let task = parse_task_file(&content)?;
    let fm = TaskFrontmatter {
        title: title.to_string(),
        created: task.created,
        completed: None,
        tags: tags.to_vec(),
    };
    let new_content = frontmatter::render(&fm, body)?;
    fs::write(&active_path, new_content)?;

    Ok(())
}

pub fn delete_task(base_dir: &Path, project_slug: &str, filename: &str) -> Result<(), CoreError> {
    if !is_valid_slug(project_slug) {
        return Err(CoreError::InvalidSlug(project_slug.to_string()));
    }
    validate_filename(filename)?;

    let active_path = path::active_tasks_dir(base_dir, project_slug).join(filename);
    if active_path.exists() {
        fs::remove_file(&active_path)?;
        return Ok(());
    }

    let done_path = path::done_tasks_dir(base_dir, project_slug).join(filename);
    if done_path.exists() {
        fs::remove_file(&done_path)?;
        return Ok(());
    }

    Err(CoreError::NotFound(format!(
        "task: {project_slug}/{filename}"
    )))
}

pub fn read_project(base_dir: &Path, slug: &str) -> Result<ProjectSummary, CoreError> {
    let file_path = path::project_file_path(base_dir, slug);
    if !file_path.exists() {
        return Err(CoreError::NotFound(format!("project: {slug}")));
    }

    let content = fs::read_to_string(&file_path)?;
    let (fm, _body): (ProjectFrontmatter, String) = frontmatter::parse(&content)?;

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
        name: fm.name,
        created: fm.created,
        description: fm.description,
        active_task_count,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectActivitySummary {
    pub slug: String,
    pub name: String,
    pub completed_tasks: Vec<TaskSummary>,
    pub active_task_count: usize,
}

pub fn get_project_activity_summary(
    base_dir: &Path,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<ProjectActivitySummary>, CoreError> {
    let projects = list_projects(base_dir)?;
    let mut result = Vec::new();

    for project in projects {
        let done_tasks = list_done_tasks(base_dir, &project.slug)?;
        let filtered: Vec<TaskSummary> = done_tasks
            .into_iter()
            .filter(|task| {
                task.completed
                    .map(|dt| {
                        let date = dt.date_naive();
                        date >= start && date <= end
                    })
                    .unwrap_or(false)
            })
            .collect();

        if !filtered.is_empty() || project.active_task_count > 0 {
            result.push(ProjectActivitySummary {
                slug: project.slug,
                name: project.name,
                completed_tasks: filtered,
                active_task_count: project.active_task_count,
            });
        }
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn fixed_offset() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn sample_datetime(
        year: i32,
        month: u32,
        day: u32,
        hour: u32,
        min: u32,
        sec: u32,
    ) -> DateTime<FixedOffset> {
        fixed_offset()
            .with_ymd_and_hms(year, month, day, hour, min, sec)
            .unwrap()
    }

    fn write_task_file(dir: &Path, filename: &str, fm: &TaskFrontmatter, body: &str) {
        let content = frontmatter::render(fm, body).unwrap();
        fs::write(dir.join(filename), content).unwrap();
    }

    fn write_done_task(tmp: &TempDir, slug: &str, filename: &str, fm: &TaskFrontmatter) {
        let done_dir = path::done_tasks_dir(tmp.path(), slug);
        let content = frontmatter::render(fm, "body").unwrap();
        fs::write(done_dir.join(filename), content).unwrap();
    }

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

        let summary = read_project(tmp.path(), "my-proj").unwrap();
        assert_eq!(summary.name, "My Project");
        assert_eq!(summary.description, "A test project");
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
        let (fm, body): (TaskFrontmatter, String) = frontmatter::parse(&content).unwrap();
        assert_eq!(fm.title, "My Task");
        assert_eq!(fm.tags, vec!["rust", "test"]);
        assert_eq!(body, "Task body");
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

        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        write_task_file(
            &active_dir,
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "First".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: None,
                tags: vec![],
            },
            "body1",
        );
        write_task_file(
            &active_dir,
            "20260102_120000.md",
            &TaskFrontmatter {
                title: "Second".to_string(),
                created: sample_datetime(2026, 1, 2, 12, 0, 0),
                completed: None,
                tags: vec![],
            },
            "body2",
        );

        let tasks = list_active_tasks(tmp.path(), "proj").unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Second");
        assert_eq!(tasks[1].title, "First");
    }

    #[test]
    fn test_complete_task() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        let filename = "20260101_120000.md";
        write_task_file(
            &active_dir,
            filename,
            &TaskFrontmatter {
                title: "Task".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: None,
                tags: vec!["a".to_string()],
            },
            "body",
        );

        complete_task(tmp.path(), "proj", filename).unwrap();

        assert!(!active_dir.join(filename).exists());

        let done_path = path::done_tasks_dir(tmp.path(), "proj").join(filename);
        assert!(done_path.exists());
        let content = fs::read_to_string(&done_path).unwrap();
        let (fm, body): (TaskFrontmatter, String) = frontmatter::parse(&content).unwrap();
        assert_eq!(fm.title, "Task");
        assert!(fm.completed.is_some());
        assert_eq!(fm.tags, vec!["a"]);
        assert_eq!(body, "body");
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
        let original_created = sample_datetime(2026, 1, 1, 12, 0, 0);
        write_task_file(
            &active_dir,
            filename,
            &TaskFrontmatter {
                title: "Old".to_string(),
                created: original_created,
                completed: None,
                tags: vec![],
            },
            "old body",
        );

        let new_tags = vec!["updated".to_string()];
        update_task(
            tmp.path(),
            "proj",
            filename,
            "New Title",
            &new_tags,
            "new body",
        )
        .unwrap();

        let content = fs::read_to_string(active_dir.join(filename)).unwrap();
        let (fm, body): (TaskFrontmatter, String) = frontmatter::parse(&content).unwrap();
        assert_eq!(fm.title, "New Title");
        assert_eq!(fm.tags, vec!["updated"]);
        assert_eq!(body, "new body");
        assert_eq!(fm.created, original_created);
    }

    #[test]
    fn test_read_project_with_active_tasks() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        write_task_file(
            &active_dir,
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "T".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: None,
                tags: vec![],
            },
            "",
        );

        let summary = read_project(tmp.path(), "proj").unwrap();
        assert_eq!(summary.active_task_count, 1);
    }

    #[test]
    fn test_activity_summary_date_filter() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let created = sample_datetime(2026, 1, 1, 12, 0, 0);
        write_done_task(
            &tmp,
            "proj",
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created,
                completed: Some(sample_datetime(2026, 1, 15, 12, 0, 0)),
                tags: vec![],
            },
        );
        write_done_task(
            &tmp,
            "proj",
            "20260201_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created,
                completed: Some(sample_datetime(2026, 2, 15, 12, 0, 0)),
                tags: vec![],
            },
        );
        write_done_task(
            &tmp,
            "proj",
            "20260301_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created,
                completed: Some(sample_datetime(2026, 3, 15, 12, 0, 0)),
                tags: vec![],
            },
        );

        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 2, 28).unwrap();
        let result = get_project_activity_summary(tmp.path(), start, end).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].completed_tasks.len(), 2);
    }

    #[test]
    fn test_activity_summary_multiple_projects() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "alpha", "Alpha", "A").unwrap();
        create_project(tmp.path(), "beta", "Beta", "B").unwrap();

        let created = sample_datetime(2026, 1, 1, 12, 0, 0);
        write_done_task(
            &tmp,
            "alpha",
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created,
                completed: Some(sample_datetime(2026, 1, 15, 12, 0, 0)),
                tags: vec![],
            },
        );
        write_done_task(
            &tmp,
            "beta",
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created,
                completed: Some(sample_datetime(2026, 1, 20, 12, 0, 0)),
                tags: vec![],
            },
        );

        let start = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        let result = get_project_activity_summary(tmp.path(), start, end).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].completed_tasks.len(), 1);
        assert_eq!(result[1].completed_tasks.len(), 1);
    }

    #[test]
    fn test_activity_summary_empty_result() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();

        let created = sample_datetime(2026, 1, 1, 12, 0, 0);
        write_done_task(
            &tmp,
            "proj",
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created,
                completed: Some(sample_datetime(2026, 1, 15, 12, 0, 0)),
                tags: vec![],
            },
        );

        let start = NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 6, 30).unwrap();
        let result = get_project_activity_summary(tmp.path(), start, end).unwrap();

        assert!(result.is_empty());
    }

    #[test]
    fn test_create_project_already_exists() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let result = create_project(tmp.path(), "proj", "Proj2", "Desc2");
        assert!(matches!(result, Err(CoreError::AlreadyExists(_))));
    }

    #[test]
    fn test_complete_task_path_traversal() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let result = complete_task(tmp.path(), "proj", "../../../etc/passwd");
        assert!(matches!(result, Err(CoreError::PathTraversal(_))));
    }

    #[test]
    fn test_update_task_path_traversal() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let result = update_task(tmp.path(), "proj", "../evil.md", "T", &[], "b");
        assert!(matches!(result, Err(CoreError::PathTraversal(_))));
    }

    #[test]
    fn test_list_active_tasks_nonexistent_project() {
        let tmp = TempDir::new().unwrap();
        let result = list_active_tasks(tmp.path(), "nonexistent");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_delete_active_task() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let active_dir = path::active_tasks_dir(tmp.path(), "proj");
        let filename = "20260101_120000.md";
        write_task_file(
            &active_dir,
            filename,
            &TaskFrontmatter {
                title: "Task".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: None,
                tags: vec![],
            },
            "body",
        );
        assert!(active_dir.join(filename).exists());
        delete_task(tmp.path(), "proj", filename).unwrap();
        assert!(!active_dir.join(filename).exists());
    }

    #[test]
    fn test_delete_done_task() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        write_done_task(
            &tmp,
            "proj",
            "20260101_120000.md",
            &TaskFrontmatter {
                title: "Task".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: Some(sample_datetime(2026, 1, 2, 12, 0, 0)),
                tags: vec![],
            },
        );
        let done_dir = path::done_tasks_dir(tmp.path(), "proj");
        assert!(done_dir.join("20260101_120000.md").exists());
        delete_task(tmp.path(), "proj", "20260101_120000.md").unwrap();
        assert!(!done_dir.join("20260101_120000.md").exists());
    }

    #[test]
    fn test_delete_task_not_found() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let result = delete_task(tmp.path(), "proj", "nonexistent.md");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_delete_task_invalid_slug() {
        let tmp = TempDir::new().unwrap();
        let result = delete_task(tmp.path(), "Bad Slug", "file.md");
        assert!(matches!(result, Err(CoreError::InvalidSlug(_))));
    }

    #[test]
    fn test_delete_task_path_traversal() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), "proj", "Proj", "Desc").unwrap();
        let result = delete_task(tmp.path(), "proj", "../../../etc/passwd");
        assert!(matches!(result, Err(CoreError::PathTraversal(_))));
    }

    #[test]
    fn test_list_done_tasks_nonexistent_project() {
        let tmp = TempDir::new().unwrap();
        let result = list_done_tasks(tmp.path(), "nonexistent");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
