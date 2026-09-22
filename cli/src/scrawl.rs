//! `scrawl add` / `scrawl show` / `scrawl dates`.
//!
//! It only appends; it never overwrites. Unlike a Note, a day the app has open only
//! gains lines, so no revision check is needed. It is the same path the Android widget
//! writes through, calling the same core function from JNI.

use std::path::Path;

use chrono::{Local, NaiveDate, NaiveTime};
use magical_merchant_core::{CoreError, Source, parse_scrawl_entry};

use crate::notes;

/// Appends to today if the body is not empty. Returns `true` when it appended.
pub(crate) fn add(data_dir: &Path, text: &str) -> Result<bool, CoreError> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(false);
    }
    // Do not fold the entry point into `notes::context()`. That is shared with MCP and
    // looks only at the device, so it would record the CLI and MCP as the same thing
    magical_merchant_core::save_scrawl_entry(data_dir, text, &notes::context(), Source::Cli)?;
    Ok(true)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) time: Option<NaiveTime>,
    pub(crate) text: String,
}

/// `YYYY-MM-DD`. Today when omitted.
pub(crate) fn resolve_date(arg: Option<&str>) -> Result<NaiveDate, CoreError> {
    arg.map_or_else(
        || Ok(Local::now().date_naive()),
        |text| {
            NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .map_err(|e| CoreError::Parse(format!("invalid date '{text}': {e}")))
        },
    )
}

pub(crate) fn show(data_dir: &Path, date: NaiveDate) -> Result<Vec<Entry>, CoreError> {
    let lines = magical_merchant_core::read_scrawl(data_dir, date)?;
    Ok(lines
        .iter()
        .map(|line| {
            let entry = parse_scrawl_entry(line);
            Entry {
                time: entry.time,
                text: entry.text,
            }
        })
        .collect())
}

pub(crate) fn dates(data_dir: &Path) -> Result<Vec<NaiveDate>, CoreError> {
    magical_merchant_core::list_scrawl_dates(data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn an_entry_is_appended_to_today_and_comes_back_with_its_time() {
        let tmp = TempDir::new().unwrap();

        assert!(add(tmp.path(), "first #memo").unwrap());
        assert!(add(tmp.path(), "  second  \n").unwrap());

        let today = Local::now().date_naive();
        let entries = show(tmp.path(), today).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "first #memo");
        assert_eq!(
            entries[1].text, "second",
            "surrounding whitespace is not recorded"
        );
        assert!(entries[0].time.is_some());
        assert_eq!(dates(tmp.path()).unwrap(), vec![today]);
    }

    /// A blank entry does not even create the day file. If an editor that was merely
    /// closed made today's file, days with no record would show up in the list.
    #[test]
    fn a_blank_entry_writes_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(!add(tmp.path(), " \n\t").unwrap());

        assert!(dates(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn a_multi_line_entry_survives_the_round_trip() {
        let tmp = TempDir::new().unwrap();

        add(tmp.path(), "line one\nline two").unwrap();

        let entries = show(tmp.path(), Local::now().date_naive()).unwrap();
        assert_eq!(entries[0].text, "line one\nline two");
    }

    #[test]
    fn a_date_argument_is_iso_and_nothing_means_today() {
        assert_eq!(
            resolve_date(Some("2026-03-20")).unwrap(),
            NaiveDate::from_ymd_opt(2026, 3, 20).unwrap()
        );
        assert_eq!(resolve_date(None).unwrap(), Local::now().date_naive());
        assert!(resolve_date(Some("20260320")).is_err());
    }

    #[test]
    fn a_day_with_no_file_is_empty_not_an_error() {
        let tmp = TempDir::new().unwrap();

        let entries = show(tmp.path(), NaiveDate::from_ymd_opt(2020, 1, 1).unwrap()).unwrap();

        assert!(entries.is_empty());
    }
}
