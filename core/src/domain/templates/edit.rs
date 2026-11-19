//! Editing templates on the template screen: the list, reading one, saving, renaming and
//! deleting.

use std::path::Path;

use serde::Serialize;

use super::draft::discard_template_draft;
use super::folder::{Summary as TemplateSummary, Templates};
use crate::error::CoreError;
use crate::utils::validated::NoteFilename;

pub fn list_templates(base_dir: &Path) -> Result<Vec<TemplateSummary>, CoreError> {
    Templates::new(base_dir).list()
}

/// The content of one template. The edit screen draws the body and the automatic tags at
/// the same time; reading them separately would open the file twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateDetail {
    /// The body as written, with variables unresolved.
    pub body: String,
    pub tags: Vec<String>,
}

pub fn read_template(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<TemplateDetail, CoreError> {
    Templates::new(base_dir)
        .read(filename)
        .map(|(fm, body)| TemplateDetail {
            body,
            tags: fm.tags,
        })
}

/// Create if missing, overwrite if present. A template's filename is just a name, not an
/// ID, so unlike a note the caller is free to recreate or rename it.
pub fn save_template(
    base_dir: &Path,
    filename: &NoteFilename,
    body: &str,
    tags: &[String],
) -> Result<(), CoreError> {
    Templates::new(base_dir).save(filename, body, tags)?;
    // The draft has now been written where it belongs
    discard_template_draft(base_dir, filename)
}

/// Deletes the template and its draft. A template that was never saved is only a draft,
/// so either one being there is enough.
pub fn delete_template(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    let draft = Templates::drafts(base_dir).delete(filename);
    match Templates::new(base_dir).delete(filename) {
        Err(CoreError::NotFound(_)) if draft.is_ok() => Ok(()),
        result => result,
    }
}

/// Give a template a new name, and its draft with it.
///
/// The notes made from it keep the old name in `template:`: they are records of where
/// they came from, and rewriting them would touch every one of those files. So the link is
/// cut, `{{prev}}` starts over, and the screen says so before the rename.
pub fn rename_template(
    base_dir: &Path,
    from: &NoteFilename,
    to: &NoteFilename,
) -> Result<(), CoreError> {
    Templates::new(base_dir).rename(from, to)?;
    match Templates::drafts(base_dir).rename(from, to) {
        Err(CoreError::NotFound(_)) => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::templates::{
        list_template_drafts, read_template_draft, save_template_draft,
    };
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

    #[test]
    fn saving_the_template_drops_its_draft() {
        let tmp = TempDir::new().unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &[])).unwrap();

        save_template(tmp.path(), &name("a.md"), "draft", &[]).unwrap();

        assert!(
            read_template_draft(tmp.path(), &name("a.md"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn deleting_a_template_deletes_its_draft() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "saved", &[]).unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &[])).unwrap();

        delete_template(tmp.path(), &name("a.md")).unwrap();

        assert!(
            read_template_draft(tmp.path(), &name("a.md"))
                .unwrap()
                .is_none()
        );
    }

    /// A new template is only a draft until it is first saved. Deleting it is deleting that.
    #[test]
    fn a_template_that_is_only_a_draft_can_be_deleted() {
        let tmp = TempDir::new().unwrap();
        save_template_draft(tmp.path(), &name("new.md"), &detail("draft", &[])).unwrap();

        delete_template(tmp.path(), &name("new.md")).unwrap();

        assert!(list_template_drafts(tmp.path()).unwrap().is_empty());
    }

    /// With neither the template nor a draft, there is nothing to delete.
    #[test]
    fn deleting_a_template_that_has_neither_file_is_not_found() {
        let tmp = TempDir::new().unwrap();

        let result = delete_template(tmp.path(), &name("nope.md"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }

    #[test]
    fn renaming_moves_the_template_to_the_new_name() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "body", &["x".to_string()]).unwrap();

        rename_template(tmp.path(), &name("a.md"), &name("b.md")).unwrap();

        assert_eq!(
            read_template(tmp.path(), &name("b.md")).unwrap(),
            detail("body", &["x"])
        );
        assert!(matches!(
            read_template(tmp.path(), &name("a.md")),
            Err(CoreError::NotFound(_))
        ));
    }

    /// A rename onto a name in use would silently replace that template.
    #[test]
    fn renaming_onto_an_existing_template_is_refused() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "a", &[]).unwrap();
        save_template(tmp.path(), &name("b.md"), "b", &[]).unwrap();

        let result = rename_template(tmp.path(), &name("a.md"), &name("b.md"));

        assert!(result.is_err());
        assert_eq!(read_template(tmp.path(), &name("a.md")).unwrap().body, "a");
        assert_eq!(read_template(tmp.path(), &name("b.md")).unwrap().body, "b");
    }

    /// The unsaved edit belongs to the template, whatever it is called.
    #[test]
    fn renaming_carries_the_draft_along() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("a.md"), "saved", &[]).unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &[])).unwrap();

        rename_template(tmp.path(), &name("a.md"), &name("b.md")).unwrap();

        assert!(
            read_template_draft(tmp.path(), &name("a.md"))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            read_template_draft(tmp.path(), &name("b.md"))
                .unwrap()
                .unwrap()
                .body,
            "draft"
        );
    }

    /// A rename moves a saved template. One that is only a draft has no file to move, so
    /// the draft stays under its old name.
    #[test]
    fn renaming_a_template_that_is_only_a_draft_is_not_found() {
        let tmp = TempDir::new().unwrap();
        save_template_draft(tmp.path(), &name("a.md"), &detail("draft", &[])).unwrap();

        let result = rename_template(tmp.path(), &name("a.md"), &name("b.md"));

        assert!(matches!(result, Err(CoreError::NotFound(_))));
        assert_eq!(
            read_template_draft(tmp.path(), &name("a.md"))
                .unwrap()
                .unwrap()
                .body,
            "draft"
        );
        assert!(
            read_template_draft(tmp.path(), &name("b.md"))
                .unwrap()
                .is_none()
        );
    }
}
