use chrono::{DateTime, Local, NaiveDate};
use std::path::{Path, PathBuf};

pub const DATA_DIR: &str = "data";
pub const TIMELINE_DIR: &str = "timeline";
pub const NOTES_DIR: &str = "notes";
pub const PROJECTS_DIR: &str = "projects";
pub const ACTIVE_DIR: &str = "active";
pub const DONE_DIR: &str = "done";
pub const PROJECT_FILE: &str = "project.md";

#[must_use]
pub fn data_dir(base_dir: &Path) -> PathBuf {
    base_dir.join(DATA_DIR)
}

#[must_use]
pub fn timeline_file_path(base_dir: &Path, date: NaiveDate) -> PathBuf {
    data_dir(base_dir)
        .join(TIMELINE_DIR)
        .join(format!("{}.md", date.format("%Y-%m-%d")))
}

#[must_use]
pub fn note_file_path(base_dir: &Path, timestamp: DateTime<Local>) -> PathBuf {
    data_dir(base_dir)
        .join(NOTES_DIR)
        .join(format!("{}.md", timestamp.format("%Y%m%d_%H%M%S")))
}

#[must_use]
pub fn notes_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(NOTES_DIR)
}

#[must_use]
pub fn projects_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(PROJECTS_DIR)
}

#[must_use]
pub fn project_dir(base_dir: &Path, slug: &str) -> PathBuf {
    projects_dir(base_dir).join(slug)
}

#[must_use]
pub fn project_file_path(base_dir: &Path, slug: &str) -> PathBuf {
    project_dir(base_dir, slug).join(PROJECT_FILE)
}

#[must_use]
pub fn active_tasks_dir(base_dir: &Path, slug: &str) -> PathBuf {
    project_dir(base_dir, slug).join(ACTIVE_DIR)
}

#[must_use]
pub fn done_tasks_dir(base_dir: &Path, slug: &str) -> PathBuf {
    project_dir(base_dir, slug).join(DONE_DIR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_timeline_file_path() {
        let date = NaiveDate::from_ymd_opt(2026, 3, 20).unwrap();
        let path = timeline_file_path(Path::new("/app"), date);
        assert_eq!(path, PathBuf::from("/app/data/timeline/2026-03-20.md"));
    }

    #[test]
    fn test_note_file_path() {
        let ts = Local.with_ymd_and_hms(2026, 3, 20, 14, 30, 45).unwrap();
        let path = note_file_path(Path::new("/app"), ts);
        assert_eq!(path, PathBuf::from("/app/data/notes/20260320_143045.md"));
    }

    #[test]
    fn test_projects_dir() {
        let path = projects_dir(Path::new("/app"));
        assert_eq!(path, PathBuf::from("/app/data/projects"));
    }

    #[test]
    fn test_project_dir() {
        let path = project_dir(Path::new("/app"), "my-project");
        assert_eq!(path, PathBuf::from("/app/data/projects/my-project"));
    }

    #[test]
    fn test_project_file_path() {
        let path = project_file_path(Path::new("/app"), "my-project");
        assert_eq!(
            path,
            PathBuf::from("/app/data/projects/my-project/project.md")
        );
    }

    #[test]
    fn test_active_tasks_dir() {
        let path = active_tasks_dir(Path::new("/app"), "my-project");
        assert_eq!(path, PathBuf::from("/app/data/projects/my-project/active"));
    }

    #[test]
    fn test_done_tasks_dir() {
        let path = done_tasks_dir(Path::new("/app"), "my-project");
        assert_eq!(path, PathBuf::from("/app/data/projects/my-project/done"));
    }
}
