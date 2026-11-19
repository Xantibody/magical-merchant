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
