//! Making a Note from a template.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::file::template_name;
use super::folder::Templates;
use super::today::{TemplateToday, today_rows};
use super::variables::{VarLocale, previous_note_link, resolve_vars};
use crate::domain::note::NoteFilename;
use crate::domain::note::NoteSummary;
use crate::domain::note::Provenance;
use crate::domain::note::{create_draft_note, list_notes};
use crate::error::CoreError;
use crate::utils::clock::WallClock;
use crate::utils::device::Context;

/// The result of running a template.
#[derive(Debug, Clone, Serialize)]
pub struct CreatedNote {
    pub path: PathBuf,
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
    let now = WallClock::now_local();
    let notes = list_notes(base_dir)?;

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

    let path = create_draft_note(
        base_dir,
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

/// Every template in name order, resolved against the notes as they are now.
///
/// The notes are listed once for all templates: `{{prev}}` needs them, and listing
/// per template would read the whole tree once per button.
pub fn templates_today(
    base_dir: &Path,
    locale: VarLocale,
) -> Result<Vec<TemplateToday>, CoreError> {
    let templates = Templates::new(base_dir);
    let summaries = templates.list()?;
    if summaries.is_empty() {
        // No template, no reason to open every note.
        return Ok(Vec::new());
    }
    let notes: Vec<NoteSummary> = list_notes(base_dir)?;

    let with_bodies = summaries
        .into_iter()
        .map(|summary| {
            // A file that vanished or broke between listing and reading still gets its
            // button; it just has no title to promise.
            let body = NoteFilename::parse(&summary.filename)
                .ok()
                .and_then(|filename| templates.read(&filename).ok())
                .map(|(_, body)| body)
                .unwrap_or_default();
            (summary, body)
        })
        .collect();
    Ok(today_rows(
        with_bodies,
        &notes,
        WallClock::now_local(),
        locale,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::note::NoteFrontmatter;
    use crate::domain::note::kind::notes_dir;
    use crate::domain::note::read_note;
    use crate::domain::templates::save_template;
    use crate::utils::clock::{Day, Stamp};
    use crate::utils::frontmatter;
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
        let time = Stamp::now_local().plus_seconds(-days_ago * 86_400);
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
        let today = Day::today_local().ymd();
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
        let month = Day::today_local().ymd()[..7].to_string();
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

    fn save(tmp: &TempDir, filename: &str, body: &str) {
        save_template(tmp.path(), &name(filename), body, &[]).unwrap();
    }

    /// Every template comes back, in name order: a button placed for the fifth template
    /// has to find it too.
    #[test]
    fn every_template_comes_back_in_name_order() {
        let tmp = TempDir::new().unwrap();
        for stem in ["e", "b", "d", "a", "c"] {
            save(&tmp, &format!("{stem}.md"), "x");
        }

        let rows = templates_today(tmp.path(), VarLocale::Ja).unwrap();

        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn no_templates_is_an_empty_list() {
        let tmp = TempDir::new().unwrap();

        assert!(
            templates_today(tmp.path(), VarLocale::Ja)
                .unwrap()
                .is_empty()
        );
    }
}
