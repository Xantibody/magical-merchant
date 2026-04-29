use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, FixedOffset, Local};

use crate::error::CoreError;
use crate::utils;
use crate::utils::paths;
use crate::utils::frontmatter::{self, ProjectFrontmatter};
use crate::utils::validated::Slug;

use super::ProjectSummary;

pub struct Projects {
    base_dir: PathBuf,
}

impl Projects {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn create(
        &self,
        slug: &Slug,
        name: &str,
        description: &str,
    ) -> Result<PathBuf, CoreError> {
        let file_path = paths::project_file_path(&self.base_dir, slug.as_str());
        if file_path.exists() {
            return Err(CoreError::AlreadyExists(format!("project: {slug}")));
        }

        let slug_str = slug.as_str();
        let proj_dir = paths::project_dir(&self.base_dir, slug_str);
        fs::create_dir_all(paths::active_tasks_dir(&self.base_dir, slug_str))?;
        fs::create_dir_all(paths::done_tasks_dir(&self.base_dir, slug_str))?;

        let now: DateTime<FixedOffset> = Local::now().into();
        let fm = ProjectFrontmatter {
            name: name.to_string(),
            created: now,
            description: description.to_string(),
        };
        let content = frontmatter::render(&fm, "")?;
        let file_path = paths::project_file_path(&self.base_dir, slug_str);
        fs::write(&file_path, content)?;

        Ok(proj_dir)
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>, CoreError> {
        let dir = paths::projects_dir(&self.base_dir);
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
                if let Ok(summary) = self.read(&slug) {
                    projects.push(summary);
                }
            }
        }

        Ok(projects)
    }

    pub fn read(&self, slug: &Slug) -> Result<ProjectSummary, CoreError> {
        let slug_str = slug.as_str();
        let file_path = paths::project_file_path(&self.base_dir, slug_str);
        if !file_path.exists() {
            return Err(CoreError::NotFound(format!("project: {slug}")));
        }

        let content = fs::read_to_string(&file_path)?;
        let (fm, _body): (ProjectFrontmatter, String) = frontmatter::parse(&content)?;

        let active_dir = paths::active_tasks_dir(&self.base_dir, slug_str);
        let active_task_count = utils::fs::count_md_files(&active_dir)?;

        Ok(ProjectSummary::from_frontmatter(
            slug_str.to_string(),
            fm,
            active_task_count,
        ))
    }
}
