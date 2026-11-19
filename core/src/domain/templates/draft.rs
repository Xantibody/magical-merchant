//! The unsaved edit of a template, kept apart from the template until an explicit save.

use std::path::Path;

use super::edit::{TemplateDetail, read_template};
use super::file::Summary as TemplateSummary;
use super::folder::Templates;
use crate::error::CoreError;
use crate::utils::validated::NoteFilename;

/// Keep the edit in progress without touching the template.
///
/// A template is what every note made from it copies, so the file changes only on an
/// explicit save. The draft is what lets that save stay explicit without an edit being
/// lost when the screen changes. A draft that matches the saved template is removed rather
/// than kept: nothing is unsaved any more. Returns whether a draft is left.
pub fn save_template_draft(
    base_dir: &Path,
    filename: &NoteFilename,
    draft: &TemplateDetail,
) -> Result<bool, CoreError> {
    let saved = read_template(base_dir, filename).ok();
    if saved.as_ref() == Some(draft) {
        discard_template_draft(base_dir, filename)?;
        return Ok(false);
    }
    Templates::drafts(base_dir).save(filename, &draft.body, &draft.tags)?;
    Ok(true)
}

/// The unsaved edit of one template, if there is one.
pub fn read_template_draft(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Option<TemplateDetail>, CoreError> {
    match Templates::drafts(base_dir).read(filename) {
        Ok((fm, body)) => Ok(Some(TemplateDetail {
            body,
            tags: fm.tags,
        })),
        Err(CoreError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Drop the unsaved edit. Nothing to drop is not an error: the caller only wants it gone.
pub fn discard_template_draft(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    match Templates::drafts(base_dir).delete(filename) {
        Err(CoreError::NotFound(_)) => Ok(()),
        result => result,
    }
}

/// Every template with an unsaved edit. One whose template file does not exist yet is a new
/// template that has never been saved.
pub fn list_template_drafts(base_dir: &Path) -> Result<Vec<TemplateSummary>, CoreError> {
    Templates::drafts(base_dir).list()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::templates::save_template;
    use tempfile::TempDir;

    fn name(s: &str) -> NoteFilename {
        NoteFilename::parse(s).unwrap()
    }

    fn detail(body: &str, tags: &[&str]) -> TemplateDetail {
        TemplateDetail {
            body: body.to_string(),
            tags: tags.iter().map(ToString::to_string).collect(),
        }
    }

    /// A draft never touches the template file: a note created meanwhile still comes from
    /// the saved shape, not from one half-written.
    #[test]
    fn a_draft_is_kept_apart_from_the_template() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "saved", &[]).unwrap();

        let kept =
            save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &["x"])).unwrap();

        assert!(kept);
        assert_eq!(
            read_template(tmp.path(), &name("a.md")).unwrap().body,
            "saved"
        );
        let draft = read_template_draft(tmp.path(), &name("a.md"))
            .unwrap()
            .unwrap();
        assert_eq!(draft.body, "draft");
        assert_eq!(draft.tags, vec!["x"]);
    }

    /// A draft is one device's unfinished edit. Synced, it would reach another device as a
    /// stray file, or race the same template being edited there.
    #[test]
    fn drafts_are_not_picked_up_by_the_sync_scan() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "saved", &[]).unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &[])).unwrap();

        let keys: Vec<String> = crate::sync::scan::scan_local_files(tmp.path())
            .unwrap()
            .into_iter()
            .map(|file| file.key)
            .collect();

        assert_eq!(keys, vec!["templates/a.md"]);
    }

    /// Typing a change and then typing it back leaves nothing unsaved.
    #[test]
    fn a_draft_equal_to_the_template_is_dropped() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "saved", &["x".to_string()]).unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &["x"])).unwrap();

        let kept =
            save_template_draft(tmp.path(), &name("a.md"), &detail("saved", &["x"])).unwrap();

        assert!(!kept);
        assert!(
            read_template_draft(tmp.path(), &name("a.md"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn discarding_a_draft_leaves_the_template() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "saved", &[]).unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &[])).unwrap();

        discard_template_draft(tmp.path(), &name("a.md")).unwrap();

        assert!(
            read_template_draft(tmp.path(), &name("a.md"))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            read_template(tmp.path(), &name("a.md")).unwrap().body,
            "saved"
        );
        // Nothing to discard is not an error: the undo of a discard may race an autosave
        discard_template_draft(tmp.path(), &name("a.md")).unwrap();
    }

    /// The list marks unsaved rows from this, and shows a draft with no template file yet
    /// as a new row.
    #[test]
    fn the_drafts_are_listed_by_name() {
        let tmp = TempDir::new().unwrap();
        save_template_draft(tmp.path(), &name("b.md"), &detail("# B {{date}}", &[])).unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("# A", &[])).unwrap();

        let drafts = list_template_drafts(tmp.path()).unwrap();

        let names: Vec<&str> = drafts.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
        assert_eq!(drafts[1].preview, "B {{date}}");
    }
}
