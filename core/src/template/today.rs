//! What each template would do if it were run now.
//!
//! The home screen buttons show the title a note made now would get. It is answered
//! here, with the same rules `create_note_from_template` follows, so a button never
//! promises a title that the tap then contradicts. The widget never resolves a variable itself.

use std::path::Path;

use chrono::{DateTime, Local};
use serde::Serialize;

use super::previous_note_link;
use super::repository::Templates;
use super::vars::{VarLocale, resolve_vars};
use crate::error::CoreError;
use crate::note::list_notes;
use crate::utils::validated::NoteFilename;

/// One template, as it stands today.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateToday {
    pub filename: String,
    /// The name minus the extension; also what a note made from it records.
    pub name: String,
    /// The title a note made now would get: the first line of the resolved body,
    /// heading marks dropped. Empty when the body resolves to nothing.
    pub today_title: String,
}

/// Every template in name order, resolved against the notes as they are now.
///
/// The notes are listed once for all templates: `{{prev}}` needs them, and listing
/// per template would read the whole tree once per button.
pub fn templates_today(
    base_dir: &Path,
    locale: VarLocale,
) -> Result<Vec<TemplateToday>, CoreError> {
    templates_today_at(base_dir, locale, Local::now())
}

fn templates_today_at(
    base_dir: &Path,
    locale: VarLocale,
    now: DateTime<Local>,
) -> Result<Vec<TemplateToday>, CoreError> {
    let templates = Templates::new(base_dir);
    let summaries = templates.list()?;
    if summaries.is_empty() {
        // No template, no reason to open every note.
        return Ok(Vec::new());
    }
    let notes = list_notes(base_dir)?;

    Ok(summaries
        .into_iter()
        .map(|summary| {
            // A file that vanished or broke between listing and reading still gets its
            // button; it just has no title to promise.
            let body = NoteFilename::parse(&summary.filename)
                .ok()
                .and_then(|filename| templates.read(&filename).ok())
                .map(|(_, body)| body)
                .unwrap_or_default();
            let prev = previous_note_link(&notes, &summary.name);
            let resolved = resolve_vars(&body, now, prev.as_deref(), locale);
            TemplateToday {
                today_title: first_line(&resolved),
                filename: summary.filename,
                name: summary.name,
            }
        })
        .collect())
}

/// The same rule as the note list's row title: the first non-empty line, without its
/// heading marks.
fn first_line(body: &str) -> String {
    body.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template::save_template;
    use chrono::TimeZone;
    use tempfile::TempDir;

    fn name(s: &str) -> NoteFilename {
        NoteFilename::parse(s).unwrap()
    }

    fn save(tmp: &TempDir, filename: &str, body: &str) {
        save_template(tmp.path(), &name(filename), body, &[]).unwrap();
    }

    /// 2026-08-31 (Mon).
    fn monday() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 8, 31, 9, 0, 0).unwrap()
    }

    #[test]
    fn the_title_is_resolved_for_today() {
        let tmp = TempDir::new().unwrap();
        save(&tmp, "daily.md", "# Daily {{date}} ({{weekday}})\n\nbody");

        let rows = templates_today_at(tmp.path(), VarLocale::Ja, monday()).unwrap();

        assert_eq!(rows[0].today_title, "Daily 2026-08-31 (月)");
        assert_eq!(rows[0].name, "daily");
    }

    /// The weekday follows the caller's language, as it does when the note is made.
    #[test]
    fn the_title_follows_the_locale() {
        let tmp = TempDir::new().unwrap();
        save(&tmp, "daily.md", "# {{weekday}}");

        let rows = templates_today_at(tmp.path(), VarLocale::En, monday()).unwrap();

        assert_eq!(rows[0].today_title, "Mon");
    }

    /// A title line with `{{prev}}` and no previous note is dropped when the note is
    /// made, so the promised title is the line after it.
    #[test]
    fn a_prev_title_line_without_a_previous_note_is_skipped() {
        let tmp = TempDir::new().unwrap();
        save(&tmp, "chain.md", "# after {{prev}}\n\n# Chain {{date}}");

        let rows = templates_today_at(tmp.path(), VarLocale::Ja, monday()).unwrap();

        assert_eq!(rows[0].today_title, "Chain 2026-08-31");
    }

    #[test]
    fn an_empty_body_promises_no_title() {
        let tmp = TempDir::new().unwrap();
        save(&tmp, "empty.md", "");

        let rows = templates_today_at(tmp.path(), VarLocale::Ja, monday()).unwrap();

        assert_eq!(rows[0].today_title, "");
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

    /// The JSON the widget parses. A renamed field reads as "no title" there, not as an error.
    #[test]
    fn the_fields_serialize_in_camel_case() {
        let row = TemplateToday {
            filename: "daily.md".to_string(),
            name: "daily".to_string(),
            today_title: "Daily".to_string(),
        };

        let json = serde_json::to_value(&row).unwrap();

        assert_eq!(json["todayTitle"], "Daily");
    }
}
