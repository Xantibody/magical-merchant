//! What the home screen widgets read.
//!
//! Split in two along what each caller pays for, not along what is convenient:
//! the capture sheet wants today's tags and reads one day file, while the notes
//! list reads every note. Folding them into one call would make opening the
//! sheet — the thing that has to feel instant — wait on the whole notes tree.
//!
//! Kotlin never parses a Scrawl line. The `- [HH:MM:SS] text {json}` shape is
//! taken apart here with the same core helpers the app uses, so a change to the
//! format cannot leave the widget rendering a stray JSON tail.

use std::path::Path;

use chrono::Local;
use magical_merchant_core::VarLocale;
use magical_merchant_core::utils::markdown::{scrawl_entry_time, strip_scrawl_prefix};
use magical_merchant_core::utils::tags;
use serde::Serialize;

/// How many rows fit in the `4x2` Note widget.
const NOTE_LIMIT: usize = 4;
/// Tag chips shown on the sheet. More than three do not fit on one line.
const TAG_LIMIT: usize = 3;
/// The bar can show one line only. A long record shows its beginning.
const PREVIEW_CHARS: usize = 60;
const UNTITLED: &str = "(空の Note)";

/// What the capture bar and the sheet need. Today's day file alone is enough.
#[derive(Debug, Default, Serialize)]
pub(crate) struct CaptureData {
    /// Today's last record, or `None` when nothing is written yet.
    last: Option<LastEntry>,
    /// Today's most used tags. Most used first; on a tie, the one seen first.
    tags: Vec<String>,
}

/// What the notes list widget needs. It reads every note.
#[derive(Debug, Default, Serialize)]
pub(crate) struct NotesData {
    /// Notes, newest first.
    notes: Vec<NoteRow>,
}

/// What the template widgets need: every template, so a button placed for any one of
/// them finds it; the 4×2 takes the first four.
#[derive(Debug, Default, Serialize)]
pub(crate) struct TemplatesData {
    /// Templates in name order. If the order changed from run to run, pressing the
    /// same position would create a different note.
    templates: Vec<TemplateRow>,
}

#[derive(Debug, Serialize)]
struct LastEntry {
    time: String,
    text: String,
}

#[derive(Debug, Serialize)]
struct NoteRow {
    title: String,
    filename: String,
    date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TemplateRow {
    /// The name shown on the button, and also the value put on the deep link.
    name: String,
    /// The title a note made now would get, variables resolved here.
    today_title: String,
    /// Today's note already exists, so a tap opens it rather than making one.
    has_today: bool,
}

/// Unreadable trees come back empty rather than as an error: a widget with no
/// data still has to draw something, and "not opened yet" is a normal state.
pub(crate) fn collect_capture(base_dir: &Path) -> CaptureData {
    let today =
        magical_merchant_core::read_scrawl(base_dir, Local::now().date_naive()).unwrap_or_default();

    CaptureData {
        last: last_entry(&today),
        tags: top_tags(&today),
    }
}

pub(crate) fn collect_notes(base_dir: &Path) -> NotesData {
    NotesData {
        notes: recent_notes(magical_merchant_core::list_notes(base_dir).unwrap_or_default()),
    }
}

/// Every template with today's title and whether today's note exists, resolved by core
/// with the rules a tap follows. `locale` only picks the weekday names; a widget speaks
/// the device's language, so Kotlin passes that.
///
/// "Today's note exists" cannot be told from the templates directory, so this walks
/// the notes tree once — but only when there is at least one template.
pub(crate) fn collect_templates(base_dir: &Path, locale: VarLocale) -> TemplatesData {
    TemplatesData {
        templates: magical_merchant_core::templates_today(base_dir, locale)
            .unwrap_or_default()
            .into_iter()
            .map(|template| TemplateRow {
                name: template.name,
                today_title: truncate(&template.today_title, PREVIEW_CHARS),
                has_today: template.has_today,
            })
            .collect(),
    }
}

/// Lines are appended in order, so the last line is the newest.
fn last_entry(entries: &[String]) -> Option<LastEntry> {
    let raw = entries.last()?;
    let text = strip_scrawl_prefix(raw);
    Some(LastEntry {
        // Seconds only eat the bar's width; when it was written is still clear.
        time: scrawl_entry_time(raw)
            .map(|t| t[..5].to_string())
            .unwrap_or_default(),
        text: truncate(text, PREVIEW_CHARS),
    })
}

fn top_tags(entries: &[String]) -> Vec<String> {
    // Count while keeping the order of appearance. If tags with the same count
    // swapped places from run to run, the chips would look reordered just from
    // opening the same screen.
    // Tags that differ only in case are one tag. The spelling shown is the first seen.
    let mut counts: Vec<(String, usize)> = Vec::new();
    for tag in entries
        .iter()
        .flat_map(|entry| tags::parse(strip_scrawl_prefix(entry)))
    {
        match counts
            .iter_mut()
            .find(|(name, _)| tags::same_tag(name, &tag))
        {
            Some((_, count)) => *count += 1,
            None => counts.push((tag, 1)),
        }
    }

    counts.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    counts
        .into_iter()
        .take(TAG_LIMIT)
        // Return them with the `#`: a chip is also the string inserted into the body
        // when pressed, so adding it on the display side would duplicate the
        // knowledge the insertion side already has.
        .map(|(tag, _)| format!("#{tag}"))
        .collect()
}

fn recent_notes(mut notes: Vec<magical_merchant_core::NoteSummary>) -> Vec<NoteRow> {
    // A note with no time is one whose frontmatter is broken, and it gives no clue
    // about ordering. Send it to the end rather than dropping it.
    notes.sort_by_key(|note| std::cmp::Reverse(note.time));
    notes
        .into_iter()
        .take(NOTE_LIMIT)
        .map(|note| NoteRow {
            title: title_of(&note.preview),
            filename: note.filename,
            date: note
                .time
                .map(|t| t.format("%m/%d").to_string())
                .unwrap_or_default(),
        })
        .collect()
}

/// The first non-empty line of the body. Same heading as the app's Note list.
fn title_of(preview: &str) -> String {
    let line = preview
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .trim_start_matches('#')
        .trim();

    if line.is_empty() {
        UNTITLED.to_string()
    } else {
        truncate(line, PREVIEW_CHARS)
    }
}

/// Newlines collapse to one line in both the bar and the list, so flatten to spaces
/// before cutting.
fn truncate(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    flat.chars().take(limit).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_line_is_the_newest_entry() {
        let entries = vec![
            "- [09:00:00] first".to_string(),
            "- [14:30:45] second {\"battery\":80}".to_string(),
        ];
        let last = last_entry(&entries).unwrap();
        assert_eq!(last.time, "14:30");
        assert_eq!(last.text, "second");
    }

    #[test]
    fn an_empty_day_has_no_last_entry() {
        assert!(last_entry(&[]).is_none());
    }

    /// An old line without a time still shows its text.
    #[test]
    fn an_entry_without_a_time_still_shows_its_text() {
        let last = last_entry(&["- plain".to_string()]).unwrap();
        assert_eq!(last.time, "");
        assert_eq!(last.text, "- plain");
    }

    /// The more used tag comes first even when the less used one appeared earlier.
    /// An order that also holds under first-seen sorting would not show whether
    /// anything is counted.
    #[test]
    fn tags_come_back_most_used_first() {
        let entries = vec![
            "- [09:00:00] #rust started".to_string(),
            "- [10:00:00] #work and #rust".to_string(),
            "- [11:00:00] #work again".to_string(),
            "- [12:00:00] #work still".to_string(),
        ];
        assert_eq!(top_tags(&entries), vec!["#work", "#rust"]);
    }

    /// On a tie, the one seen first. If the order changed from run to run, the chips
    /// would look swapped just from opening the same screen.
    #[test]
    fn tags_used_equally_keep_their_first_seen_order() {
        let entries = vec![
            "- [09:00:00] #b then #a".to_string(),
            "- [10:00:00] #a and #b".to_string(),
        ];
        assert_eq!(top_tags(&entries), vec!["#b", "#a"]);
    }

    /// Spellings that differ only in case are one tag. Counted separately, the
    /// widget would show two chips for the same category.
    #[test]
    fn tags_that_differ_only_in_case_are_one_chip() {
        let entries = vec![
            "- [09:00:00] #CognitiveBias を疑う".to_string(),
            "- [10:00:00] また #cognitivebias".to_string(),
        ];
        assert_eq!(top_tags(&entries), vec!["#CognitiveBias"]);
    }

    /// From the fourth on, the chips do not fit on one line, so they are dropped.
    /// The ones dropped are the least used tags.
    #[test]
    fn only_the_most_used_tags_fit_on_the_sheet() {
        let entries = vec![
            "- [09:00:00] #d once".to_string(),
            "- [10:00:00] #a #b #c".to_string(),
            "- [11:00:00] #a #b #c".to_string(),
            "- [12:00:00] #a #b".to_string(),
            "- [13:00:00] #a".to_string(),
        ];
        let tags = top_tags(&entries);
        assert_eq!(tags.len(), TAG_LIMIT);
        assert_eq!(tags, vec!["#a", "#b", "#c"]);
    }

    #[test]
    fn a_day_without_tags_has_no_chips() {
        assert!(top_tags(&["- [09:00:00] plain".to_string()]).is_empty());
    }

    #[test]
    fn a_long_entry_is_cut_with_an_ellipsis() {
        let long = "a".repeat(PREVIEW_CHARS + 10);
        let last = last_entry(&[format!("- [09:00:00] {long}")]).unwrap();
        assert_eq!(last.text.chars().count(), PREVIEW_CHARS + 1);
        assert!(last.text.ends_with('…'));
    }

    #[test]
    fn a_heading_becomes_the_note_title() {
        assert_eq!(title_of("# Hello\nbody"), "Hello");
    }

    #[test]
    fn a_blank_note_is_labelled_rather_than_left_empty() {
        assert_eq!(title_of("\n  \n"), UNTITLED);
    }

    fn save_template(tmp: &tempfile::TempDir, name: &str, body: &str) {
        let filename = magical_merchant_core::NoteFilename::parse(&format!("{name}.md")).unwrap();
        magical_merchant_core::save_template(tmp.path(), &filename, body, &[]).unwrap();
    }

    /// A button can be placed for any template, so none is cut off here; the 4×2
    /// takes its four on the Kotlin side.
    #[test]
    fn every_template_reaches_the_widget_in_name_order() {
        let tmp = tempfile::TempDir::new().unwrap();
        for name in ["e", "a", "d", "b", "c"] {
            save_template(&tmp, name, "body");
        }

        let data = collect_templates(tmp.path(), VarLocale::Ja);

        // Name order. If the order changed, pressing the same position would create
        // a different note
        let names: Vec<&str> = data.templates.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c", "d", "e"]);
    }

    /// Kotlin reads these two keys by name and never resolves a variable itself.
    #[test]
    fn a_row_carries_todays_title_and_whether_it_exists() {
        let tmp = tempfile::TempDir::new().unwrap();
        save_template(&tmp, "daily", "# Daily {{date}}\n\nbody");

        let json = serde_json::to_value(collect_templates(tmp.path(), VarLocale::Ja)).unwrap();

        let today = Local::now().format("%Y-%m-%d").to_string();
        let row = &json["templates"][0];
        assert_eq!(row["todayTitle"], format!("Daily {today}"));
        assert_eq!(row["hasToday"], false);
    }

    /// A device with no templates at all is the normal state. Let it draw empty.
    #[test]
    fn a_tree_without_templates_comes_back_empty() {
        let tmp = tempfile::TempDir::new().unwrap();

        assert!(
            collect_templates(tmp.path(), VarLocale::Ja)
                .templates
                .is_empty()
        );
    }
}
