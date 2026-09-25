//! Note templates.
//!
//! A template itself is plain Markdown under `data/templates/*.md`, synced the same way
//! as a note. The only special thing is that `{{...}}` can be written in the body and the
//! tags; it becomes a value at the moment a note is created from here. Inside the template
//! file it stays a string to the end (`vars`).

mod repository;
mod today;
mod vars;

pub use repository::Summary as TemplateSummary;
pub use today::{TemplateToday, templates_today};
pub use vars::VarLocale;

use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;

use crate::error::CoreError;
use crate::note::{NoteSummary, Notes};
use crate::utils::device::Context;
use crate::utils::frontmatter::Provenance;
use crate::utils::validated::NoteFilename;
use repository::Templates;
use vars::resolve_vars;

/// The result of running a template.
#[derive(Debug, Clone, Serialize)]
pub struct CreatedNote {
    pub path: PathBuf,
}

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

/// Create a note from a template.
///
/// Every call makes a new note, even when one from the same template exists today.
/// AIDEV-NOTE: reusing today's note was tried and dropped — a tap that sometimes opens
/// and sometimes creates was the surprise, not the extra note.
///
/// `provenance` is the origin the caller declares. Only the template name is filled in
/// here: making the caller pass what the filename already gives only adds mistakes.
pub fn create_note_from_template(
    base_dir: &Path,
    filename: &NoteFilename,
    context: &Context,
    locale: VarLocale,
    provenance: Provenance<'_>,
) -> Result<CreatedNote, CoreError> {
    let (fm, body) = Templates::new(base_dir).read(filename)?;
    let name = template_name(filename);
    let now = Local::now();
    let notes = crate::note::list_notes(base_dir)?;

    let prev = previous_note_link(&notes, name);
    let resolved = resolve_vars(&body, now, prev.as_deref(), locale);
    // Nobody writes `{{prev}}` in a tag, but if one did, the drop-the-line rule applies as
    // is and yields an empty string. An empty tag is not a tag
    let tags: Vec<String> = fm
        .tags
        .iter()
        .map(|tag| resolve_vars(tag, now, prev.as_deref(), locale))
        .filter(|tag| !tag.trim().is_empty())
        .collect();

    let path = Notes::new(base_dir.to_path_buf()).create(
        &resolved,
        &tags,
        context,
        Provenance {
            template: Some(name),
            ..provenance
        },
    )?;

    Ok(CreatedNote { path })
}

/// The name recorded in the frontmatter. The filename itself minus the extension.
fn template_name(filename: &NoteFilename) -> &str {
    let name = filename.as_str();
    name.strip_suffix(".md").unwrap_or(name)
}

/// The `[[ID]]` link to the note last created from the same template.
fn previous_note_link(notes: &[NoteSummary], template: &str) -> Option<String> {
    notes
        .iter()
        .filter(|note| note.template.as_deref() == Some(template))
        .filter_map(|note| note.time.map(|time| (time, &note.filename)))
        .max_by_key(|(time, _)| *time)
        .map(|(_, filename)| format!("[[{}]]", filename.strip_suffix(".md").unwrap_or(filename)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note::{list_notes, read_note};
    use crate::utils::frontmatter::{self, NoteFrontmatter};
    use crate::utils::paths::notes_dir;
    use std::fs;
    use tempfile::TempDir;

    fn context() -> Context {
        Context::default()
    }

    fn name(s: &str) -> NoteFilename {
        NoteFilename::parse(s).unwrap()
    }

    fn daily(tmp: &TempDir) {
        save_template(
            tmp.path(),
            &name("daily.md"),
            "# Daily {{date}}\n\n## 今日やること\n\n前回: {{prev}}",
            &["daily".to_string(), "{{date:YYYY-MM}}".to_string()],
        )
        .unwrap();
    }

    /// Write a note with a past date directly. `{{prev}}` is decided by date, so `create_note_from_template` (creation time is now)
    /// cannot set up a note from yesterday or earlier.
    fn seed_note(tmp: &TempDir, filename: &str, template: &str, days_ago: i64) {
        let time = (Local::now() - chrono::Duration::days(days_ago)).fixed_offset();
        let fm = NoteFrontmatter {
            template: Some(template.to_string()),
            ..NoteFrontmatter::new(time)
        };
        let dir = notes_dir(tmp.path());
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(filename),
            frontmatter::render(&fm, "既にあるノート").unwrap(),
        )
        .unwrap();
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

    #[test]
    fn creating_resolves_the_variables_in_the_body() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        let body = read_note(&created.path).unwrap();
        let today = Local::now().format("%Y-%m-%d").to_string();
        assert!(body.contains(&format!("# Daily {today}")));
        assert!(!body.contains("{{"));
    }

    /// The first note has no previous one. No line of only `前回: ` is left.
    #[test]
    fn the_first_note_has_no_previous_line() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(!read_note(&created.path).unwrap().contains("前回"));
    }

    #[test]
    fn the_next_note_links_back_to_the_previous_one() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        seed_note(&tmp, "20260830_090000.md", "daily", 1);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(
            read_note(&created.path)
                .unwrap()
                .contains("前回: [[20260830_090000]]")
        );
    }

    /// "Previous" is the latest note "from the same template". It never points at another
    /// template's note.
    #[test]
    fn the_previous_link_ignores_other_templates() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        seed_note(&tmp, "20260830_090000.md", "weekly", 1);

        let created = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert!(!read_note(&created.path).unwrap().contains("前回"));
    }

    #[test]
    fn the_tags_are_resolved_and_recorded() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        let listed = list_notes(tmp.path()).unwrap();
        let month = Local::now().format("%Y-%m").to_string();
        assert!(listed[0].tags.contains(&"daily".to_string()));
        assert!(listed[0].tags.contains(&month));
    }

    /// Without the origin recorded, the next note's `{{prev}}` has nothing to point at.
    #[test]
    fn the_note_records_which_template_it_came_from() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);

        create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(
            list_notes(tmp.path()).unwrap()[0].template,
            Some("daily".to_string())
        );
    }

    /// A template is a stamp: each tap makes a note, even twice in one day.
    #[test]
    fn every_tap_creates_a_new_note() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        let run = || {
            create_note_from_template(
                tmp.path(),
                &name("daily.md"),
                &context(),
                VarLocale::Ja,
                Provenance::default(),
            )
            .unwrap()
        };

        let first = run();
        let second = run();

        assert_ne!(second.path, first.path);
        assert_eq!(list_notes(tmp.path()).unwrap().len(), 2);
    }

    /// Only the weekday changes with the language. The template content is the same.
    #[test]
    fn the_weekday_follows_the_locale_of_the_caller() {
        let tmp = TempDir::new().unwrap();
        save_template(tmp.path(), &name("w.md"), "{{weekday}}", &[]).unwrap();

        let created = create_note_from_template(
            tmp.path(),
            &name("w.md"),
            &context(),
            VarLocale::En,
            Provenance::default(),
        )
        .unwrap();

        let body = read_note(&created.path).unwrap();
        assert!(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].contains(&body.trim()));
    }

    #[test]
    fn creating_from_a_missing_template_is_not_found() {
        let tmp = TempDir::new().unwrap();

        let result = create_note_from_template(
            tmp.path(),
            &name("nope.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        );

        assert!(matches!(result, Err(CoreError::NotFound(_))));
    }
}
