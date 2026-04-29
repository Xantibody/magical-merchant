mod model;
pub mod task;

pub use model::{ProjectActivitySummary, ProjectSummary};
pub use task::{
    TaskSummary, complete_task, create_task, delete_task, list_active_tasks, list_done_tasks,
    update_task,
};

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local, NaiveDate};

use crate::error::CoreError;
use crate::infra::fs_helpers;
use crate::infra::paths;
use crate::shared::frontmatter::{self, ProjectFrontmatter};
use crate::shared::validated::Slug;

pub fn create_project(
    base_dir: &Path,
    slug: &Slug,
    name: &str,
    description: &str,
) -> Result<PathBuf, CoreError> {
    let file_path = paths::project_file_path(base_dir, slug.as_str());
    if file_path.exists() {
        return Err(CoreError::AlreadyExists(format!("project: {slug}")));
    }

    let slug_str = slug.as_str();
    let proj_dir = paths::project_dir(base_dir, slug_str);
    fs::create_dir_all(paths::active_tasks_dir(base_dir, slug_str))?;
    fs::create_dir_all(paths::done_tasks_dir(base_dir, slug_str))?;

    let now: DateTime<FixedOffset> = Local::now().into();
    let fm = ProjectFrontmatter {
        name: name.to_string(),
        created: now,
        description: description.to_string(),
    };
    let content = frontmatter::render(&fm, "")?;
    let file_path = paths::project_file_path(base_dir, slug_str);
    fs::write(&file_path, content)?;

    Ok(proj_dir)
}

pub fn list_projects(base_dir: &Path) -> Result<Vec<ProjectSummary>, CoreError> {
    let dir = paths::projects_dir(base_dir);
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
        let slug_str = entry.file_name().to_string_lossy().to_string();
        if let Ok(slug) = Slug::parse(&slug_str) {
            if let Ok(summary) = read_project(base_dir, &slug) {
                projects.push(summary);
            }
        }
    }

    Ok(projects)
}

pub fn read_project(base_dir: &Path, slug: &Slug) -> Result<ProjectSummary, CoreError> {
    let slug_str = slug.as_str();
    let file_path = paths::project_file_path(base_dir, slug_str);
    if !file_path.exists() {
        return Err(CoreError::NotFound(format!("project: {slug}")));
    }

    let content = fs::read_to_string(&file_path)?;
    let (fm, _body): (ProjectFrontmatter, String) = frontmatter::parse(&content)?;

    let active_dir = paths::active_tasks_dir(base_dir, slug_str);
    let active_task_count = fs_helpers::count_md_files(&active_dir)?;

    Ok(ProjectSummary::from_frontmatter(
        slug_str.to_string(),
        fm,
        active_task_count,
    ))
}

pub fn get_project_activity_summary(
    base_dir: &Path,
    start: NaiveDate,
    end: NaiveDate,
) -> Result<Vec<ProjectActivitySummary>, CoreError> {
    let projects = list_projects(base_dir)?;
    let mut result = Vec::new();

    for project in projects {
        let slug = Slug::parse(&project.slug).expect("already validated by list_projects");
        let done_tasks = list_done_tasks(base_dir, &slug)?;
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
    use crate::shared::frontmatter::TaskFrontmatter;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn slug(s: &str) -> Slug {
        Slug::parse(s).unwrap()
    }

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

    fn write_done_task(tmp: &TempDir, slug: &str, filename: &str, fm: &TaskFrontmatter) {
        let done_dir = paths::done_tasks_dir(tmp.path(), slug);
        let content = frontmatter::render(fm, "body").unwrap();
        fs::write(done_dir.join(filename), content).unwrap();
    }

    #[test]
    fn test_create_project() {
        let tmp = TempDir::new().unwrap();
        let s = slug("my-proj");
        let result = create_project(tmp.path(), &s, "My Project", "A test project");
        assert!(result.is_ok());

        let proj_dir = result.unwrap();
        assert!(proj_dir.exists());
        assert!(paths::project_file_path(tmp.path(), "my-proj").exists());
        assert!(paths::active_tasks_dir(tmp.path(), "my-proj").exists());
        assert!(paths::done_tasks_dir(tmp.path(), "my-proj").exists());

        let summary = read_project(tmp.path(), &s).unwrap();
        assert_eq!(summary.name, "My Project");
        assert_eq!(summary.description, "A test project");
    }

    #[test]
    fn test_create_project_invalid_slug() {
        assert!(Slug::parse("Bad Slug").is_err());
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
        create_project(tmp.path(), &slug("alpha"), "Alpha", "First").unwrap();
        create_project(tmp.path(), &slug("beta"), "Beta", "Second").unwrap();

        let projects = list_projects(tmp.path()).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].slug, "alpha");
        assert_eq!(projects[1].slug, "beta");
    }

    #[test]
    fn test_read_project() {
        let tmp = TempDir::new().unwrap();
        let s = slug("test-proj");
        create_project(tmp.path(), &s, "Test", "Desc").unwrap();

        let summary = read_project(tmp.path(), &s).unwrap();
        assert_eq!(summary.slug, "test-proj");
        assert_eq!(summary.name, "Test");
        assert_eq!(summary.description, "Desc");
        assert_eq!(summary.active_task_count, 0);
    }

    #[test]
    fn test_read_project_not_found() {
        let tmp = TempDir::new().unwrap();
        let result = read_project(tmp.path(), &slug("nonexistent"));
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_read_project_with_active_tasks() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();

        let active_dir = paths::active_tasks_dir(tmp.path(), "proj");
        let fm = TaskFrontmatter {
            title: "T".to_string(),
            created: sample_datetime(2026, 1, 1, 12, 0, 0),
            completed: None,
            tags: vec![],
        };
        let content = frontmatter::render(&fm, "").unwrap();
        fs::write(active_dir.join("20260101_120000.md"), content).unwrap();

        let summary = read_project(tmp.path(), &s).unwrap();
        assert_eq!(summary.active_task_count, 1);
    }

    #[test]
    fn test_activity_summary_date_filter() {
        let tmp = TempDir::new().unwrap();
        create_project(tmp.path(), &slug("proj"), "Proj", "Desc").unwrap();

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
        create_project(tmp.path(), &slug("alpha"), "Alpha", "A").unwrap();
        create_project(tmp.path(), &slug("beta"), "Beta", "B").unwrap();

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
        create_project(tmp.path(), &slug("proj"), "Proj", "Desc").unwrap();

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
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();
        let result = create_project(tmp.path(), &s, "Proj2", "Desc2");
        assert!(matches!(result, Err(CoreError::AlreadyExists(_))));
    }
}
