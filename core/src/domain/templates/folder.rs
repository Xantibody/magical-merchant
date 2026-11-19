//! One folder of template files: the templates themselves in `data/templates/`, or their
//! drafts in `template-drafts/`. The edit and draft operations both reach the disk here.

use std::path::{Path, PathBuf};

use super::file::{
    Summary, TemplateFrontmatter, parse_file, render_file, summarize, template_drafts_dir,
    templates_dir,
};
use crate::error::CoreError;
use crate::services::files::{
    list_md_files, read_text, remove, rename_no_replace, resolve_existing, resolve_writable,
    write_atomic,
};
use crate::utils::validated::NoteFilename;

/// One directory of template files. The same shape serves the templates themselves and
/// anything else stored as a template file.
pub(crate) struct Templates {
    dir: PathBuf,
}

impl Templates {
    pub(crate) fn new(base_dir: &Path) -> Self {
        Self {
            dir: templates_dir(base_dir),
        }
    }

    /// The drafts: files of the same shape, one per template, outside the synced tree.
    pub(crate) fn drafts(base_dir: &Path) -> Self {
        Self {
            dir: template_drafts_dir(base_dir),
        }
    }

    fn existing_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        resolve_existing(&self.dir, filename.as_str())
    }

    /// The write target for a file that does not exist yet. `NoteFilename` rejects `/`
    /// and `..`, so the result is always directly under this directory.
    fn writable_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        resolve_writable(&self.dir, filename.as_str())
    }

    pub(crate) fn list(&self) -> Result<Vec<Summary>, CoreError> {
        let mut summaries: Vec<Summary> = list_md_files(&self.dir)?
            .into_iter()
            .map(|entry| {
                let filename = entry.file_name().to_string_lossy().to_string();
                let content = read_text(&entry.path()).unwrap_or_default();
                summarize(filename, &content)
            })
            .collect();

        // By name. Old and new mean nothing for a template; the name is the only handle to find one
        summaries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(summaries)
    }

    /// Return the frontmatter and the body separately.
    pub(crate) fn read(
        &self,
        filename: &NoteFilename,
    ) -> Result<(TemplateFrontmatter, String), CoreError> {
        let content = read_text(&self.existing_path(filename)?)?;
        Ok(parse_file(&content))
    }

    pub(crate) fn save(
        &self,
        filename: &NoteFilename,
        body: &str,
        tags: &[String],
    ) -> Result<(), CoreError> {
        let path = self.writable_path(filename)?;
        write_atomic(&path, render_file(body, tags)?)
    }

    /// Move a file to a new name, never over one that exists: a taken name is an error,
    /// not a silent replace.
    pub(crate) fn rename(&self, from: &NoteFilename, to: &NoteFilename) -> Result<(), CoreError> {
        let source = self.existing_path(from)?;
        let target = self.writable_path(to)?;
        rename_no_replace(&source, &target)
    }

    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        remove(&self.existing_path(filename)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn templates(tmp: &TempDir) -> Templates {
        Templates::new(tmp.path())
    }

    fn name(s: &str) -> NoteFilename {
        NoteFilename::parse(s).unwrap()
    }

    #[test]
    fn saving_then_reading_round_trips_the_body_and_tags() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);

        t.save(
            &name("daily.md"),
            "# Daily {{date}}\n\n## メモ",
            &["daily".to_string()],
        )
        .unwrap();

        let (fm, body) = t.read(&name("daily.md")).unwrap();
        assert_eq!(fm.tags, vec!["daily"]);
        assert!(fm.template);
        assert_eq!(body, "# Daily {{date}}\n\n## メモ");
    }

    /// Templates live under `data/`. The sync scan walks everything under data, so outside
    /// it a template never reaches other devices.
    #[test]
    fn templates_are_written_inside_the_data_directory() {
        let tmp = TempDir::new().unwrap();

        templates(&tmp)
            .save(&name("daily.md"), "body", &[])
            .unwrap();

        assert!(tmp.path().join("data/templates/daily.md").exists());
    }

    /// Variables stay strings inside the template. Resolved on save, the template would
    /// keep emitting a fixed date from the second use on.
    #[test]
    fn saving_does_not_resolve_variables() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);

        t.save(
            &name("daily.md"),
            "# {{date}}",
            &["{{date:YYYY-MM}}".to_string()],
        )
        .unwrap();

        let raw = fs::read_to_string(tmp.path().join("data/templates/daily.md")).unwrap();
        assert!(raw.contains("{{date}}"));
        assert!(raw.contains("{{date:YYYY-MM}}"));
    }

    #[test]
    fn the_list_is_sorted_by_name() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(&name("weekly.md"), "# 週次", &[]).unwrap();
        t.save(&name("daily.md"), "# 日次", &[]).unwrap();

        let names: Vec<String> = t.list().unwrap().into_iter().map(|s| s.name).collect();

        assert_eq!(names, vec!["daily", "weekly"]);
    }

    #[test]
    fn a_summary_carries_the_tags_and_the_first_line() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(
            &name("daily.md"),
            "# Daily {{date}}\n\n本文",
            &["daily".to_string()],
        )
        .unwrap();

        let listed = t.list().unwrap();

        assert_eq!(listed[0].filename, "daily.md");
        assert_eq!(listed[0].tags, vec!["daily"]);
        // Heading marks are dropped, variables are kept
        assert_eq!(listed[0].preview, "Daily {{date}}");
    }

    /// Every leading `#` goes, so a body that opens with a `#tag` loses the tag's mark too.
    /// Pinned as it stands; the title rule step decides whether it stays.
    #[test]
    fn a_preview_drops_every_leading_hash() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(&name("tagged.md"), "#tag rest\n\nbody", &[])
            .unwrap();

        let listed = t.list().unwrap();

        assert_eq!(listed[0].preview, "tag rest");
    }

    /// A template can be dropped in by hand. A file without frontmatter is read as plain Markdown.
    #[test]
    fn a_file_without_frontmatter_is_still_a_template() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/templates");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plain.md"), "# 手で置いたテンプレ").unwrap();

        let (fm, body) = templates(&tmp).read(&name("plain.md")).unwrap();

        assert!(fm.tags.is_empty());
        assert_eq!(body, "# 手で置いたテンプレ");
    }

    #[test]
    fn deleting_removes_the_file() {
        let tmp = TempDir::new().unwrap();
        let t = templates(&tmp);
        t.save(&name("daily.md"), "body", &[]).unwrap();

        t.delete(&name("daily.md")).unwrap();

        assert!(!tmp.path().join("data/templates/daily.md").exists());
        assert!(t.list().unwrap().is_empty());
    }

    #[test]
    fn reading_a_missing_template_is_not_found() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("data/templates")).unwrap();

        let result = templates(&tmp).read(&name("nope.md"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    /// Name validation alone can be made to read outside the directory through a link.
    #[test]
    fn a_symlink_out_of_the_directory_is_refused() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/templates");
        fs::create_dir_all(&dir).unwrap();
        fs::write(tmp.path().join("outside.md"), "secret").unwrap();
        std::os::unix::fs::symlink(tmp.path().join("outside.md"), dir.join("linked.md")).unwrap();

        let result = templates(&tmp).read(&name("linked.md"));

        assert!(matches!(result, Err(CoreError::PathTraversal(_))));
    }

    #[test]
    fn an_empty_directory_lists_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(templates(&tmp).list().unwrap().is_empty());
    }
}
