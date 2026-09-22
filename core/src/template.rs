//! Note templates.
//!
//! A template itself is plain Markdown under `data/templates/*.md`, synced the same way
//! as a note. The only special thing is that `{{...}}` can be written in the body and the
//! tags; it becomes a value at the moment a note is created from here. Inside the template
//! file it stays a string to the end (`vars`).

mod repository;
mod vars;

pub use repository::Summary as TemplateSummary;
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
    /// Today's note already existed, so it was opened instead of creating one.
    ///
    /// To the caller both are "open", but it is unkind not to convey why pressing does not
    /// raise the count, so the two are kept distinguishable.
    pub reused: bool,
}

pub fn list_templates(base_dir: &Path) -> Result<Vec<TemplateSummary>, CoreError> {
    Templates::new(base_dir.to_path_buf()).list()
}

/// The content of one template. The edit screen draws the body and the automatic tags at
/// the same time; reading them separately would open the file twice.
#[derive(Debug, Clone, Serialize)]
pub struct TemplateDetail {
    /// The body as written, with variables unresolved.
    pub body: String,
    pub tags: Vec<String>,
}

pub fn read_template(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<TemplateDetail, CoreError> {
    Templates::new(base_dir.to_path_buf())
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
    Templates::new(base_dir.to_path_buf()).save(filename, body, tags)
}

pub fn delete_template(base_dir: &Path, filename: &NoteFilename) -> Result<(), CoreError> {
    Templates::new(base_dir.to_path_buf()).delete(filename)
}

/// Create a note from a template.
///
/// If today's note from the same template already exists, return it instead of creating
/// one. Tapping a daily template from the widget several times a day is normal, and if an
/// empty "Daily" piled up each time, the template would be the nuisance.
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
    let (fm, body) = Templates::new(base_dir.to_path_buf()).read(filename)?;
    let name = template_name(filename);
    let now = Local::now();
    let notes = crate::note::list_notes(base_dir)?;

    if let Some(existing) = todays_note(&notes, name, now) {
        return Ok(CreatedNote {
            path: existing.path.clone(),
            reused: true,
        });
    }

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

    Ok(CreatedNote {
        path,
        reused: false,
    })
}

/// The name recorded in the frontmatter. The filename itself minus the extension.
fn template_name(filename: &NoteFilename) -> &str {
    let name = filename.as_str();
    name.strip_suffix(".md").unwrap_or(name)
}

fn todays_note<'a>(
    notes: &'a [NoteSummary],
    template: &str,
    now: chrono::DateTime<Local>,
) -> Option<&'a NoteSummary> {
    let today = now.date_naive();
    notes.iter().find(|note| {
        note.template.as_deref() == Some(template)
            && note
                .time
                .is_some_and(|time| time.with_timezone(&Local).date_naive() == today)
    })
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

    /// Write a note with a past date directly. Both `{{prev}}` and "does today's already
    /// exist" are decided by date, so `create_note_from_template` (creation time is now)
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
        assert!(!created.reused);
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

    /// Without the origin recorded, neither the next note's `{{prev}}` nor the same-day
    /// check works.
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

    /// However many times a daily template is tapped in a day, that day has one note.
    #[test]
    fn the_same_template_reuses_todays_note() {
        let tmp = TempDir::new().unwrap();
        daily(&tmp);
        let first = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        let second = create_note_from_template(
            tmp.path(),
            &name("daily.md"),
            &context(),
            VarLocale::Ja,
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(second.path, first.path);
        assert!(second.reused);
        assert_eq!(list_notes(tmp.path()).unwrap().len(), 1);
    }

    /// Yesterday's note is not today's. Once the day changes, a new one is created.
    #[test]
    fn yesterdays_note_does_not_stand_in_for_todays() {
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

        assert!(!created.reused);
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
