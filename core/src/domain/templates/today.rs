//! What each template would do if it were run now.
//!
//! The home screen buttons show the title a note made now would get. It is answered
//! here, with the same rules `create_note_from_template` follows, so a button never
//! promises a title that the tap then contradicts. The widget never resolves a variable itself.

use serde::Serialize;

use super::file::Summary;
use super::variables::{VarLocale, previous_note_link, resolve_vars};
use crate::note::NoteSummary;
use crate::utils::clock::WallClock;

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

/// One row per template, in the order given, resolved against `notes` at `now`.
///
/// Each template comes with its body as written; one whose body could not be read comes
/// with an empty body and still gets its row, with no title to promise.
pub(crate) fn today_rows(
    templates: Vec<(Summary, String)>,
    notes: &[NoteSummary],
    now: WallClock,
    locale: VarLocale,
) -> Vec<TemplateToday> {
    templates
        .into_iter()
        .map(|(summary, body)| {
            let prev = previous_note_link(notes, &summary.name);
            let resolved = resolve_vars(&body, now, prev.as_deref(), locale);
            TemplateToday {
                today_title: first_line(&resolved),
                filename: summary.filename,
                name: summary.name,
            }
        })
        .collect()
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
    use crate::note::NoteKind;
    use crate::utils::clock::Stamp;
    use std::path::PathBuf;

    /// 2026-08-31 (Mon).
    fn monday() -> WallClock {
        WallClock::new(2026, 8, 31, 9, 0, 0).unwrap()
    }

    fn template(stem: &str, body: &str) -> (Summary, String) {
        let summary = Summary {
            filename: format!("{stem}.md"),
            name: stem.to_string(),
            tags: Vec::new(),
            preview: String::new(),
        };
        (summary, body.to_string())
    }

    /// A note made from `template` on 2026-08-`day` at 09:00 (+09:00).
    fn note_from(template: &str, filename: &str, day: u32) -> NoteSummary {
        NoteSummary {
            kind: NoteKind::Note,
            path: PathBuf::from(filename),
            filename: filename.to_string(),
            time: Some(Stamp::new(2026, 8, day, 9, 0, 0, 9 * 3600).unwrap()),
            tags: Vec::new(),
            preview: String::new(),
            origin: None,
            template: Some(template.to_string()),
            view: None,
            version_count: None,
            dirty: None,
        }
    }

    fn titles(rows: &[TemplateToday]) -> Vec<&str> {
        rows.iter().map(|row| row.today_title.as_str()).collect()
    }

    #[test]
    fn the_title_is_resolved_for_today() {
        let rows = today_rows(
            vec![template("daily", "# Daily {{date}} ({{weekday}})\n\nbody")],
            &[],
            monday(),
            VarLocale::Ja,
        );

        assert_eq!(rows[0].today_title, "Daily 2026-08-31 (月)");
        assert_eq!(rows[0].name, "daily");
        assert_eq!(rows[0].filename, "daily.md");
    }

    /// The weekday follows the caller's language, as it does when the note is made.
    #[test]
    fn the_title_follows_the_locale() {
        let rows = today_rows(
            vec![template("daily", "# {{weekday}}")],
            &[],
            monday(),
            VarLocale::En,
        );

        assert_eq!(titles(&rows), ["Mon"]);
    }

    /// A title line with `{{prev}}` and no previous note is dropped when the note is
    /// made, so the promised title is the line after it.
    #[test]
    fn a_prev_title_line_without_a_previous_note_is_skipped() {
        let rows = today_rows(
            vec![template("chain", "# after {{prev}}\n\n# Chain {{date}}")],
            &[],
            monday(),
            VarLocale::Ja,
        );

        assert_eq!(titles(&rows), ["Chain 2026-08-31"]);
    }

    /// `{{prev}}` points at the latest note made from the same template.
    #[test]
    fn prev_resolves_to_the_latest_note_of_the_same_template() {
        let notes = [
            note_from("chain", "20260828_090000.md", 28),
            note_from("chain", "20260830_090000.md", 30),
            note_from("chain", "20260829_090000.md", 29),
        ];

        let rows = today_rows(
            vec![template("chain", "# after {{prev}}")],
            &notes,
            monday(),
            VarLocale::Ja,
        );

        assert_eq!(titles(&rows), ["after [[20260830_090000]]"]);
    }

    /// Another template's note is never the previous one.
    #[test]
    fn prev_never_picks_another_templates_note() {
        let notes = [note_from("weekly", "20260830_090000.md", 30)];

        let rows = today_rows(
            vec![template("chain", "# after {{prev}}\n# Chain")],
            &notes,
            monday(),
            VarLocale::Ja,
        );

        assert_eq!(titles(&rows), ["Chain"]);
    }

    /// A template whose body could not be read comes with an empty body and still gets
    /// its row, in the order given.
    #[test]
    fn a_template_without_a_body_still_gets_its_row() {
        let rows = today_rows(
            vec![
                template("a", "# A"),
                template("broken", ""),
                template("c", "# C"),
            ],
            &[],
            monday(),
            VarLocale::Ja,
        );

        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, ["a", "broken", "c"]);
        assert_eq!(titles(&rows), ["A", "", "C"]);
    }

    /// Every leading `#` goes, so a body that opens with a `#tag` loses the tag's mark too.
    /// Pinned as it stands; the title rule step decides whether it stays.
    #[test]
    fn a_title_drops_every_leading_hash() {
        let rows = today_rows(
            vec![template("tagged", "#tag rest\n\nbody")],
            &[],
            monday(),
            VarLocale::Ja,
        );

        assert_eq!(titles(&rows), ["tag rest"]);
    }

    #[test]
    fn an_empty_body_promises_no_title() {
        let rows = today_rows(vec![template("empty", "")], &[], monday(), VarLocale::Ja);

        assert_eq!(titles(&rows), [""]);
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
