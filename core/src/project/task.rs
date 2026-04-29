mod model;
pub mod repository;

pub use model::TaskSummary;
pub use repository::Tasks;

use std::path::{Path, PathBuf};

use crate::error::CoreError;
use crate::utils;
use crate::utils::validated::{Filename, Slug};

pub(crate) fn list_tasks_in_dir(dir: &Path) -> Result<Vec<TaskSummary>, CoreError> {
    let entries = utils::fs::list_md_files(dir)?;

    let mut tasks = Vec::new();
    for entry in entries {
        let filename = entry.file_name().to_string_lossy().to_string();
        let content = std::fs::read_to_string(entry.path())?;
        let task = TaskSummary::from_content(&filename, &content)?;
        tasks.push(task);
    }

    Ok(tasks)
}

pub fn create_task(
    base_dir: &Path,
    project_slug: &Slug,
    title: &str,
    tags: &[String],
    body: &str,
) -> Result<PathBuf, CoreError> {
    Tasks::new(base_dir.to_path_buf()).create(project_slug, title, tags, body)
}

pub fn list_active_tasks(
    base_dir: &Path,
    project_slug: &Slug,
) -> Result<Vec<TaskSummary>, CoreError> {
    Tasks::new(base_dir.to_path_buf()).list_active(project_slug)
}

pub fn list_done_tasks(
    base_dir: &Path,
    project_slug: &Slug,
) -> Result<Vec<TaskSummary>, CoreError> {
    Tasks::new(base_dir.to_path_buf()).list_done(project_slug)
}

pub fn complete_task(
    base_dir: &Path,
    project_slug: &Slug,
    filename: &Filename,
) -> Result<(), CoreError> {
    Tasks::new(base_dir.to_path_buf()).complete(project_slug, filename)
}

pub fn update_task(
    base_dir: &Path,
    project_slug: &Slug,
    filename: &Filename,
    title: &str,
    tags: &[String],
    body: &str,
) -> Result<(), CoreError> {
    Tasks::new(base_dir.to_path_buf()).update(project_slug, filename, title, tags, body)
}

pub fn delete_task(
    base_dir: &Path,
    project_slug: &Slug,
    filename: &Filename,
) -> Result<(), CoreError> {
    Tasks::new(base_dir.to_path_buf()).delete(project_slug, filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::create_project;
    use crate::utils::frontmatter::{self, TaskFrontmatter};
    use crate::utils::paths;
    use chrono::{DateTime, FixedOffset, TimeZone};
    use std::fs;
    use tempfile::TempDir;

    fn slug(s: &str) -> Slug {
        Slug::parse(s).unwrap()
    }

    fn filename(s: &str) -> Filename {
        Filename::parse(s).unwrap()
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

    fn write_task_file(dir: &Path, filename: &str, fm: &TaskFrontmatter, body: &str) {
        let content = frontmatter::render(fm, body).unwrap();
        fs::write(dir.join(filename), content).unwrap();
    }

    fn write_done_task(tmp: &TempDir, slug: &str, filename: &str, fm: &TaskFrontmatter) {
        let done_dir = paths::done_tasks_dir(tmp.path(), slug);
        let content = frontmatter::render(fm, "body").unwrap();
        fs::write(done_dir.join(filename), content).unwrap();
    }

    #[test]
    fn test_create_task() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();

        let tags = vec!["rust".to_string(), "test".to_string()];
        let path = create_task(tmp.path(), &s, "My Task", &tags, "Task body").unwrap();
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
        let result = create_task(tmp.path(), &slug("nonexistent"), "Task", &[], "body");
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_list_active_tasks_empty() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();
        let tasks = list_active_tasks(tmp.path(), &s).unwrap();
        assert!(tasks.is_empty());
    }

    #[test]
    fn test_list_active_tasks_multiple() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();

        let active_dir = paths::active_tasks_dir(tmp.path(), "proj");
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

        let tasks = list_active_tasks(tmp.path(), &s).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Second");
        assert_eq!(tasks[1].title, "First");
    }

    #[test]
    fn test_complete_task() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();

        let active_dir = paths::active_tasks_dir(tmp.path(), "proj");
        let fname = "20260101_120000.md";
        write_task_file(
            &active_dir,
            fname,
            &TaskFrontmatter {
                title: "Task".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: None,
                tags: vec!["a".to_string()],
            },
            "body",
        );

        complete_task(tmp.path(), &s, &filename(fname)).unwrap();

        assert!(!active_dir.join(fname).exists());

        let done_path = paths::done_tasks_dir(tmp.path(), "proj").join(fname);
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
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();
        let result = complete_task(tmp.path(), &s, &filename("nonexistent.md"));
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_update_task() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();

        let active_dir = paths::active_tasks_dir(tmp.path(), "proj");
        let fname = "20260101_120000.md";
        let original_created = sample_datetime(2026, 1, 1, 12, 0, 0);
        write_task_file(
            &active_dir,
            fname,
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
            &s,
            &filename(fname),
            "New Title",
            &new_tags,
            "new body",
        )
        .unwrap();

        let content = fs::read_to_string(active_dir.join(fname)).unwrap();
        let (fm, body): (TaskFrontmatter, String) = frontmatter::parse(&content).unwrap();
        assert_eq!(fm.title, "New Title");
        assert_eq!(fm.tags, vec!["updated"]);
        assert_eq!(body, "new body");
        assert_eq!(fm.created, original_created);
    }

    #[test]
    fn test_complete_task_path_traversal() {
        assert!(Filename::parse("../../../etc/passwd").is_err());
    }

    #[test]
    fn test_update_task_path_traversal() {
        assert!(Filename::parse("../evil.md").is_err());
    }

    #[test]
    fn test_list_active_tasks_nonexistent_project() {
        let tmp = TempDir::new().unwrap();
        let result = list_active_tasks(tmp.path(), &slug("nonexistent"));
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_delete_active_task() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();
        let active_dir = paths::active_tasks_dir(tmp.path(), "proj");
        let fname = "20260101_120000.md";
        write_task_file(
            &active_dir,
            fname,
            &TaskFrontmatter {
                title: "Task".to_string(),
                created: sample_datetime(2026, 1, 1, 12, 0, 0),
                completed: None,
                tags: vec![],
            },
            "body",
        );
        assert!(active_dir.join(fname).exists());
        delete_task(tmp.path(), &s, &filename(fname)).unwrap();
        assert!(!active_dir.join(fname).exists());
    }

    #[test]
    fn test_delete_done_task() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();
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
        let done_dir = paths::done_tasks_dir(tmp.path(), "proj");
        assert!(done_dir.join("20260101_120000.md").exists());
        delete_task(tmp.path(), &s, &filename("20260101_120000.md")).unwrap();
        assert!(!done_dir.join("20260101_120000.md").exists());
    }

    #[test]
    fn test_delete_task_not_found() {
        let tmp = TempDir::new().unwrap();
        let s = slug("proj");
        create_project(tmp.path(), &s, "Proj", "Desc").unwrap();
        let result = delete_task(tmp.path(), &s, &filename("nonexistent.md"));
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn test_delete_task_invalid_slug() {
        assert!(Slug::parse("Bad Slug").is_err());
    }

    #[test]
    fn test_delete_task_path_traversal() {
        assert!(Filename::parse("../../../etc/passwd").is_err());
    }

    #[test]
    fn test_list_done_tasks_nonexistent_project() {
        let tmp = TempDir::new().unwrap();
        let result = list_done_tasks(tmp.path(), &slug("nonexistent"));
        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
