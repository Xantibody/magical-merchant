use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, FixedOffset, Local};

use crate::error::CoreError;
use crate::infra::paths;
use crate::shared::frontmatter::{self, TaskFrontmatter};
use crate::shared::validated::{Filename, Slug};

use super::model::TaskSummary;
use super::list_tasks_in_dir;

pub trait TaskRepository {
    fn create(
        &self,
        project_slug: &Slug,
        title: &str,
        tags: &[String],
        body: &str,
    ) -> Result<PathBuf, CoreError>;
    fn list_active(&self, project_slug: &Slug) -> Result<Vec<TaskSummary>, CoreError>;
    fn list_done(&self, project_slug: &Slug) -> Result<Vec<TaskSummary>, CoreError>;
    fn complete(&self, project_slug: &Slug, filename: &Filename) -> Result<(), CoreError>;
    fn update(
        &self,
        project_slug: &Slug,
        filename: &Filename,
        title: &str,
        tags: &[String],
        body: &str,
    ) -> Result<(), CoreError>;
    fn delete(&self, project_slug: &Slug, filename: &Filename) -> Result<(), CoreError>;
}

pub struct FsTaskRepository {
    base_dir: PathBuf,
}

impl FsTaskRepository {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }
}

impl TaskRepository for FsTaskRepository {
    fn create(
        &self,
        project_slug: &Slug,
        title: &str,
        tags: &[String],
        body: &str,
    ) -> Result<PathBuf, CoreError> {
        let active_dir = paths::active_tasks_dir(&self.base_dir, project_slug.as_str());
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

    fn list_active(&self, project_slug: &Slug) -> Result<Vec<TaskSummary>, CoreError> {
        let slug_str = project_slug.as_str();
        let project_file = paths::project_file_path(&self.base_dir, slug_str);
        if !project_file.exists() {
            return Err(CoreError::NotFound(format!("project: {project_slug}")));
        }
        list_tasks_in_dir(&paths::active_tasks_dir(&self.base_dir, slug_str))
    }

    fn list_done(&self, project_slug: &Slug) -> Result<Vec<TaskSummary>, CoreError> {
        let slug_str = project_slug.as_str();
        let project_file = paths::project_file_path(&self.base_dir, slug_str);
        if !project_file.exists() {
            return Err(CoreError::NotFound(format!("project: {project_slug}")));
        }
        list_tasks_in_dir(&paths::done_tasks_dir(&self.base_dir, slug_str))
    }

    fn complete(&self, project_slug: &Slug, filename: &Filename) -> Result<(), CoreError> {
        let slug_str = project_slug.as_str();
        let fname = filename.as_str();
        let active_path = paths::active_tasks_dir(&self.base_dir, slug_str).join(fname);
        if !active_path.exists() {
            return Err(CoreError::NotFound(format!(
                "task: {project_slug}/{filename}"
            )));
        }

        let content = fs::read_to_string(&active_path)?;
        let mut task = TaskSummary::from_content(fname, &content)?;

        let now: DateTime<FixedOffset> = Local::now().into();
        task.completed = Some(now);
        let fm = task.to_frontmatter();
        let new_content = frontmatter::render(&fm, &task.body)?;

        let done_path = paths::done_tasks_dir(&self.base_dir, slug_str).join(fname);
        fs::write(&done_path, new_content)?;
        fs::remove_file(&active_path)?;

        Ok(())
    }

    fn update(
        &self,
        project_slug: &Slug,
        filename: &Filename,
        title: &str,
        tags: &[String],
        body: &str,
    ) -> Result<(), CoreError> {
        let active_path =
            paths::active_tasks_dir(&self.base_dir, project_slug.as_str()).join(filename.as_str());
        if !active_path.exists() {
            return Err(CoreError::NotFound(format!(
                "task: {project_slug}/{filename}"
            )));
        }

        let content = fs::read_to_string(&active_path)?;
        let task = TaskSummary::from_content(filename.as_str(), &content)?;
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

    fn delete(&self, project_slug: &Slug, filename: &Filename) -> Result<(), CoreError> {
        let slug_str = project_slug.as_str();
        let fname = filename.as_str();
        let active_path = paths::active_tasks_dir(&self.base_dir, slug_str).join(fname);
        if active_path.exists() {
            fs::remove_file(&active_path)?;
            return Ok(());
        }

        let done_path = paths::done_tasks_dir(&self.base_dir, slug_str).join(fname);
        if done_path.exists() {
            fs::remove_file(&done_path)?;
            return Ok(());
        }

        Err(CoreError::NotFound(format!(
            "task: {project_slug}/{filename}"
        )))
    }
}
