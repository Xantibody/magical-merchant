//! The shape of a template file: its frontmatter, how a file is read and written, the
//! list entry made from it, its name, and the folders that hold the templates and their
//! drafts. Plain values in and out; the operations beside it touch the disk.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::data::data_dir;
use crate::domain::note::NoteFilename;
use crate::utils::error::CoreError;
use crate::utils::frontmatter;

const TEMPLATES_DIR: &str = "templates";

/// The frontmatter of a template file. A separate type from the note's.
/// A note always has `time`, but a creation time means nothing for a template: a template
/// is reused, and the thing that has a time is the note born from it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct TemplateFrontmatter {
    /// The mark that this is a template. Sitting in `templates/` alone does not tell
    /// someone who opens this file in another Markdown tool.
    #[serde(default = "yes")]
    pub template: bool,
    /// Tags added automatically to notes created from here. A variable such as
    /// `{{date:YYYY-MM}}` can be written, and it resolves at the moment a note is created.
    #[serde(default)]
    pub tags: Vec<String>,
}

const fn yes() -> bool {
    true
}

impl Default for TemplateFrontmatter {
    fn default() -> Self {
        Self {
            template: true,
            tags: Vec::new(),
        }
    }
}

/// One entry of the template list.
#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub filename: String,
    /// The name minus the extension (`daily` for `daily.md`). It is the name shown on
    /// screen, and also the value recorded in the frontmatter of notes created from here.
    pub name: String,
    pub tags: Vec<String>,
    /// The first line of the body, variables unresolved. The list resolves them for today
    /// on screen, in the locale the screen is in, which core does not know.
    pub preview: String,
}

/// Where templates live.
///
/// Inside `data/` because templates should sync too. With different templates per device, tapping
/// the same name from the widget would produce a different note depending on the device.
#[must_use]
pub(crate) fn templates_dir(base_dir: &Path) -> PathBuf {
    data_dir(base_dir).join(TEMPLATES_DIR)
}

/// Where the unsaved edits of templates live, one file per template.
///
/// Outside `data/`. A draft is one device's unfinished edit: synced, it would reach
/// another device as a stray file, or fight the same template being edited there. The
/// template itself syncs once it is saved.
#[must_use]
pub(crate) fn template_drafts_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("template-drafts")
}

/// Split a template file into its frontmatter and its body. The body is owned: the caller
/// always resolves variables and rebuilds it, so returning a borrow gains nothing.
pub(crate) fn parse_file(content: &str) -> (TemplateFrontmatter, String) {
    frontmatter::parse::<TemplateFrontmatter>(content).map_or_else(
        // A template without frontmatter is treated as plain Markdown, used as the
        // body as is. A user can also drop a template in by hand
        |_| {
            (
                TemplateFrontmatter::default(),
                frontmatter::strip(content).to_string(),
            )
        },
        |(fm, body)| (fm, body.to_string()),
    )
}

/// The text of a template file holding `body` and the automatic `tags`.
pub(crate) fn render_file(body: &str, tags: &[String]) -> Result<String, CoreError> {
    let fm = TemplateFrontmatter {
        template: true,
        tags: tags.to_vec(),
    };
    frontmatter::render(&fm, body)
}

/// The list entry for the file `filename` holding `content`.
pub(crate) fn summarize(filename: String, content: &str) -> Summary {
    let (tags, body) = frontmatter::parse::<TemplateFrontmatter>(content).map_or_else(
        // Treating broken frontmatter as body puts YAML in the list preview
        |_| (Vec::new(), frontmatter::strip(content)),
        |(fm, body)| (fm.tags, body),
    );

    let name = filename
        .strip_suffix(".md")
        .unwrap_or(&filename)
        .to_string();
    // Heading marks are dropped. What the list wants to show is the title, not Markdown
    let preview = body
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
        .to_string();

    Summary {
        filename,
        name,
        tags,
        preview,
    }
}

/// The name recorded in the frontmatter. The filename itself minus the extension.
pub(crate) fn template_name(filename: &NoteFilename) -> &str {
    let name = filename.as_str();
    name.strip_suffix(".md").unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Templates are inside `data/` too. The sync scan walks everything under data,
    /// so just being here gets them to the other devices.
    #[test]
    fn templates_live_inside_the_synced_tree() {
        assert_eq!(
            templates_dir(Path::new("/app")),
            PathBuf::from("/app/data/templates")
        );
    }

    /// Drafts sit outside `data/`, so the sync scan never carries one to another device.
    #[test]
    fn drafts_live_outside_the_synced_tree() {
        assert_eq!(
            template_drafts_dir(Path::new("/app")),
            PathBuf::from("/app/template-drafts")
        );
    }

    /// A template dropped in by hand has no frontmatter: the whole text is its body.
    #[test]
    fn a_file_without_frontmatter_is_all_body() {
        let (fm, body) = parse_file("# Daily {{date}}\n\nbody");

        assert_eq!(fm, TemplateFrontmatter::default());
        assert_eq!(body, "# Daily {{date}}\n\nbody");
    }

    /// Broken frontmatter is dropped rather than read as body: YAML in a new note would
    /// be worse than losing the automatic tags.
    #[test]
    fn broken_frontmatter_is_dropped_from_the_body() {
        let (fm, body) = parse_file("---\ntags: [unclosed\n---\n# Daily\n");

        assert_eq!(fm, TemplateFrontmatter::default());
        assert_eq!(body, "# Daily\n");
    }

    /// `template:` is the mark for other Markdown tools; a file that leaves it out is still
    /// a template.
    #[test]
    fn the_template_mark_defaults_to_true() {
        let (fm, body) = parse_file("---\ntags: [daily]\n---\nbody");

        assert!(fm.template);
        assert_eq!(fm.tags, vec!["daily"]);
        assert_eq!(body, "body");
    }

    /// What is written is what is read back, variables included.
    #[test]
    fn a_rendered_file_parses_back_to_its_body_and_tags() {
        let rendered =
            render_file("# {{date}}\n\nbody", &["{{date:YYYY-MM}}".to_string()]).unwrap();

        let (fm, body) = parse_file(&rendered);

        assert!(fm.template);
        assert_eq!(fm.tags, vec!["{{date:YYYY-MM}}"]);
        assert_eq!(body, "# {{date}}\n\nbody");
    }

    #[test]
    fn a_summary_names_the_template_without_its_extension() {
        let summary = summarize("daily.md".to_string(), "---\ntags: [daily]\n---\n# Daily\n");

        assert_eq!(summary.filename, "daily.md");
        assert_eq!(summary.name, "daily");
        assert_eq!(summary.tags, vec!["daily"]);
        assert_eq!(summary.preview, "Daily");
    }

    /// The preview is the first line with text, not a blank line above it.
    #[test]
    fn a_preview_skips_blank_lines() {
        let summary = summarize("a.md".to_string(), "\n\n## Weekly {{date}}\nbody");

        assert_eq!(summary.preview, "Weekly {{date}}");
    }

    /// Treating broken frontmatter as body would put YAML in the list preview.
    #[test]
    fn broken_frontmatter_never_reaches_the_preview() {
        let summary = summarize("a.md".to_string(), "---\ntags: [unclosed\n---\n# Title\n");

        assert_eq!(summary.preview, "Title");
        assert!(summary.tags.is_empty());
    }

    /// Every leading `#` goes, so a body that opens with a `#tag` loses the tag's mark too.
    /// Pinned as it stands; the title rule step decides whether it stays.
    #[test]
    fn a_preview_drops_every_leading_hash() {
        let summary = summarize("a.md".to_string(), "#tag rest\n\nbody");

        assert_eq!(summary.preview, "tag rest");
    }

    #[test]
    fn the_recorded_name_is_the_filename_without_its_extension() {
        let filename = NoteFilename::parse("daily.md").unwrap();

        assert_eq!(template_name(&filename), "daily");
    }
}
