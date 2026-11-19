//! Where records were written: every Scrawl line and note that carries coordinates,
//! counted by the cell its [`place_key`] names.

use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::path::Path;

use crate::domain::device::Location;
use crate::domain::device::place::{cell_centre, place_key};
use crate::domain::note::id::newest_first;
use crate::domain::note::{NoteFilename, NoteKind, read_note_meta};
use crate::domain::scrawl::entry::parse_scrawl_entry;
use crate::domain::scrawl::journal::{list_scrawl_dates, read_scrawl};
use crate::services::files::list_md_files;
use crate::utils::clock::Day;
use crate::utils::error::CoreError;

/// One cell of about 1 km that at least one record was written in.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaceVisit {
    /// The cell, as [`place_key`] spells it.
    pub place_key: String,
    /// The centre of the cell: [`cell_centre`] of the first record counted in it.
    pub latitude: f64,
    pub longitude: f64,
    /// Scrawl lines written here.
    pub entries: usize,
    /// Notes and Codexes created here.
    pub notes: usize,
    /// The earliest and the latest day a record here was written on.
    pub first: Day,
    pub last: Day,
}

/// Every cell records were written in, most records first, cells with as many in key order.
///
/// Scrawl days are read newest first, then every Note and Codex newest first, each once
/// with its frontmatter parsed once. A note whose record cannot be read only misses the
/// map; it is no reason to stop the count.
pub fn visited_places(base_dir: &Path) -> Result<Vec<PlaceVisit>, CoreError> {
    let mut cells: BTreeMap<String, PlaceVisit> = BTreeMap::new();
    let mut visit = |location: &Location, day: Day, is_note: bool| {
        let key = place_key(location.latitude, location.longitude);
        let cell = cells.entry(key.clone()).or_insert_with(|| PlaceVisit {
            place_key: key,
            latitude: cell_centre(location.latitude),
            longitude: cell_centre(location.longitude),
            entries: 0,
            notes: 0,
            first: day,
            last: day,
        });
        if is_note {
            cell.notes += 1;
        } else {
            cell.entries += 1;
        }
        cell.first = cell.first.min(day);
        cell.last = cell.last.max(day);
    };

    for date in list_scrawl_dates(base_dir)? {
        for line in read_scrawl(base_dir, date)? {
            if let Some(location) = parse_scrawl_entry(&line).context.location {
                visit(&location, date, false);
            }
        }
    }
    for filename in note_ids(base_dir)? {
        let Ok(meta) = read_note_meta(base_dir, &filename) else {
            continue;
        };
        if let Some(location) = meta.context.and_then(|c| c.location) {
            visit(&location, meta.time.day(), true);
        }
    }

    let mut places: Vec<PlaceVisit> = cells.into_values().collect();
    places.sort_by_key(|p| Reverse(p.entries + p.notes));
    Ok(places)
}

/// The ID of every Note and Codex, newest first, without opening one. A name that is not
/// an ID is left out.
fn note_ids(base_dir: &Path) -> Result<Vec<NoteFilename>, CoreError> {
    let mut names = Vec::new();
    for kind in [NoteKind::Note, NoteKind::Codex] {
        for entry in list_md_files(&kind.dir(base_dir))? {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    newest_first(&mut names, Clone::clone);
    Ok(names
        .iter()
        .filter_map(|name| NoteFilename::parse(name).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::Context;
    use crate::domain::note::{Provenance, create_note_at};
    use crate::domain::scrawl::entry::format_scrawl_line;
    use crate::utils::clock::{Stamp, WallClock};
    use std::fs;
    use tempfile::TempDir;

    fn at(latitude: f64, longitude: f64) -> Context {
        Context {
            location: Some(Location {
                latitude,
                longitude,
            }),
            ..Context::default()
        }
    }

    fn day(text: &str) -> Day {
        Day::parse_ymd(text).unwrap()
    }

    /// One day file with a line per `(hour, context)`.
    fn write_day(base: &Path, date: &str, lines: &[(u32, Context)]) {
        let dir = base.join("data/scrawl");
        fs::create_dir_all(&dir).unwrap();
        let d = day(date);
        let text: Vec<String> = lines
            .iter()
            .map(|(hour, ctx)| {
                let wall = WallClock::new(d.year(), d.month(), d.day(), *hour, 0, 0).unwrap();
                format_scrawl_line("line", wall, ctx)
            })
            .collect();
        fs::write(dir.join(format!("{date}.md")), text.join("\n") + "\n").unwrap();
    }

    fn note_at(base: &Path, time: &str, context: &Context) {
        create_note_at(
            base,
            time.parse::<Stamp>().unwrap(),
            "note",
            &[],
            context,
            Provenance::default(),
        )
        .unwrap();
    }

    #[test]
    fn an_empty_tree_was_written_nowhere() {
        let tmp = TempDir::new().unwrap();

        assert_eq!(visited_places(tmp.path()).unwrap(), Vec::new());
    }

    /// Lines and notes in one cell count together, apart by kind, between the first and
    /// the last day; the busiest cell comes first.
    #[test]
    fn records_in_one_cell_count_together_busiest_first() {
        let tmp = TempDir::new().unwrap();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, at(35.6762, 139.6503)), (10, at(35.6769, 139.6509))],
        );
        write_day(tmp.path(), "2026-03-01", &[(9, at(43.06, 141.35))]);
        note_at(
            tmp.path(),
            "2026-02-01T09:00:00+09:00",
            &at(35.6762, 139.6503),
        );

        let places = visited_places(tmp.path()).unwrap();

        assert_eq!(
            places,
            [
                PlaceVisit {
                    place_key: "35.68,139.65".to_string(),
                    latitude: 35.68,
                    longitude: 139.65,
                    entries: 2,
                    notes: 1,
                    first: day("2026-01-15"),
                    last: day("2026-02-01"),
                },
                PlaceVisit {
                    place_key: "43.06,141.35".to_string(),
                    latitude: 43.06,
                    longitude: 141.35,
                    entries: 1,
                    notes: 0,
                    first: day("2026-03-01"),
                    last: day("2026-03-01"),
                },
            ]
        );
    }

    /// A note whose record cannot be read, and one without coordinates, only miss the map.
    #[test]
    fn notes_without_a_readable_place_are_passed_over() {
        let tmp = TempDir::new().unwrap();
        note_at(tmp.path(), "2026-02-01T09:00:00+09:00", &Context::default());
        let dir = tmp.path().join("data/notes");
        fs::write(
            dir.join("20260101_120000.md"),
            "---\ntime: [broken\n---\nbody",
        )
        .unwrap();

        assert_eq!(visited_places(tmp.path()).unwrap(), Vec::new());
    }

    /// Cells with as many records come in key order.
    #[test]
    fn cells_with_as_many_records_come_in_key_order() {
        let tmp = TempDir::new().unwrap();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, at(43.06, 141.35)), (10, at(-33.86, -70.66))],
        );

        let keys: Vec<String> = visited_places(tmp.path())
            .unwrap()
            .into_iter()
            .map(|p| p.place_key)
            .collect();

        assert_eq!(keys, ["-33.86,-70.66", "43.06,141.35"]);
    }
}
