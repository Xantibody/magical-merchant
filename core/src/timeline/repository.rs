use std::fs;
use std::path::PathBuf;

use chrono::{Local, NaiveDate};

use crate::error::CoreError;
use crate::infra::fs_helpers::ensure_dir;
use crate::infra::markdown::format_timeline_line;
use crate::infra::paths::timeline_file_path;
use crate::shared::context::DeviceContext;

pub struct Timeline {
    base_dir: PathBuf,
}

impl Timeline {
    pub fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    pub fn save_entry(&self, text: &str, context: &DeviceContext) -> Result<(), CoreError> {
        let now = Local::now();
        let file_path = timeline_file_path(&self.base_dir, now.date_naive());
        ensure_dir(&file_path)?;

        let line = format_timeline_line(text, now, context);

        let mut content = if file_path.exists() {
            fs::read_to_string(&file_path)?
        } else {
            String::new()
        };

        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&line);
        content.push('\n');

        fs::write(&file_path, content)?;
        Ok(())
    }

    pub fn list_dates(&self) -> Result<Vec<NaiveDate>, CoreError> {
        let timeline_dir = self.base_dir.join("data").join("timeline");
        if !timeline_dir.exists() {
            return Ok(Vec::new());
        }

        let mut dates: Vec<NaiveDate> = fs::read_dir(&timeline_dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let stem = name.strip_suffix(".md")?;
                NaiveDate::parse_from_str(stem, "%Y-%m-%d").ok()
            })
            .collect();

        dates.sort_by(|a, b| b.cmp(a));
        Ok(dates)
    }

    pub fn read(&self, date: NaiveDate) -> Result<Vec<String>, CoreError> {
        let file_path = timeline_file_path(&self.base_dir, date);
        if !file_path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(&file_path)?;
        let lines = content
            .lines()
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect();
        Ok(lines)
    }
}
