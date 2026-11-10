//! How many records carry each tag: the tag editor's suggestions and the MCP `list_tags`.
//!
//! The count is taken here rather than by whoever asks, so that what crosses to the screen is
//! one row per tag instead of every record.

use std::collections::BTreeMap;
use std::path::Path;

use chrono::NaiveDate;
use serde::Serialize;

use crate::error::CoreError;
use crate::list_scrawl_dates;
use crate::note::Notes;
use crate::scrawl::Scrawl;
use crate::scrawl::day::DayLog;
use crate::utils::markdown::strip_scrawl_prefix;
use crate::utils::tags;

/// One tag and how many records carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagUsage {
    /// The spelling of the newest record carrying it.
    pub tag: String,
    /// Notes and Codexes carrying the tag.
    pub notes: usize,
    /// Scrawl entries carrying the tag.
    pub entries: usize,
}

impl TagUsage {
    /// Records of either kind carrying the tag.
    #[must_use]
    pub const fn total(&self) -> usize {
        self.notes + self.entries
    }
}

/// Which column a record is counted in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Record {
    Note,
    Entry,
}

/// One row of the tally, with the date of the record that gave it its name.
#[derive(Debug)]
struct Row {
    usage: TagUsage,
    named_on: Option<NaiveDate>,
}

/// The count itself, fed one record at a time so the store is never held at once.
///
/// Rows are keyed by the folded tag (`tags::fold_tag`), so spellings that differ only in case
/// are one row. A record's own tags are already folded (`tags::parse`, `tags::merge`), so it
/// never adds to one row twice.
#[derive(Debug, Default)]
struct Tally {
    rows: BTreeMap<String, Row>,
}

impl Tally {
    /// `date` is the record's day; a note without a frontmatter time has none.
    ///
    /// The row takes the spelling of the newest record, and on the same day keeps the first
    /// one read. Fed in [`count_tags`]' reading order, that is the first spelling met in
    /// `browse_all`'s newest-first list, which is what the screen counted before.
    fn add(&mut self, record: Record, date: Option<NaiveDate>, tags: &[String]) {
        for tag in tags {
            let row = self.rows.entry(tags::fold_tag(tag)).or_insert_with(|| Row {
                usage: TagUsage {
                    tag: tag.clone(),
                    notes: 0,
                    entries: 0,
                },
                named_on: date,
            });
            if date > row.named_on {
                row.usage.tag.clone_from(tag);
                row.named_on = date;
            }
            match record {
                Record::Note => row.usage.notes += 1,
                Record::Entry => row.usage.entries += 1,
            }
        }
    }

    /// Most used first. The sort is stable over the map's order, so a tie goes by the
    /// folded name and the list holds still between calls.
    fn finish(self) -> Vec<TagUsage> {
        let mut counted: Vec<TagUsage> = self.rows.into_values().map(|row| row.usage).collect();
        counted.sort_by_key(|usage| std::cmp::Reverse(usage.total()));
        counted
    }
}

/// Every tag carried by a Scrawl entry, a Note or a Codex, most used first.
///
/// It reads what `browse_all` reads (every day file and every note), but hands back one row
/// per tag instead of every record. A note's tags are its frontmatter's and its body's
/// together, an entry's are its text's; code is not read on either side (`tags::parse`).
/// It only reads, so a tree still on `data/timeline/` is not migrated here.
pub fn count_tags(base_dir: &Path) -> Result<Vec<TagUsage>, CoreError> {
    let mut tally = Tally::default();

    let scrawl = Scrawl::new(base_dir.to_path_buf());
    for date in list_scrawl_dates(base_dir)? {
        let Some(content) = scrawl.read_raw(date)? else {
            continue;
        };
        // A tag starts with `#`, so a day without one has nothing to split
        if !content.contains('#') {
            continue;
        }
        for entry in DayLog::parse(&content).into_entries() {
            tally.add(
                Record::Entry,
                Some(date),
                &tags::parse(strip_scrawl_prefix(&entry)),
            );
        }
    }

    // An unreadable note comes with no tags and adds nothing, as in `browse_all`
    Notes::new(base_dir.to_path_buf()).scan(|note, _| {
        tally.add(
            Record::Note,
            note.time.map(|time| time.date_naive()),
            &note.tags,
        );
    })?;

    Ok(tally.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::{self, NoteFrontmatter};
    use crate::utils::device::Context;
    use crate::{Provenance, browse_all, create_draft_codex, create_draft_note};
    use chrono::{FixedOffset, TimeZone};
    use tempfile::TempDir;

    fn day(text: &str) -> NaiveDate {
        NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    fn tags(names: &[&str]) -> Vec<String> {
        names.iter().map(ToString::to_string).collect()
    }

    fn usage(tag: &str, notes: usize, entries: usize) -> TagUsage {
        TagUsage {
            tag: tag.to_string(),
            notes,
            entries,
        }
    }

    // ──────────── the tally ────────────

    #[test]
    fn nothing_added_counts_nothing() {
        assert_eq!(Tally::default().finish(), Vec::new());
    }

    /// A count is how many records carry the tag, so a note and an entry are kept apart and
    /// each record adds one.
    #[test]
    fn notes_and_entries_are_counted_apart() {
        let mut tally = Tally::default();
        tally.add(Record::Entry, Some(day("2026-01-02")), &tags(&["run"]));
        tally.add(
            Record::Entry,
            Some(day("2026-01-01")),
            &tags(&["run", "rest"]),
        );
        tally.add(Record::Note, Some(day("2026-01-01")), &tags(&["run"]));

        assert_eq!(
            tally.finish(),
            vec![usage("run", 1, 2), usage("rest", 0, 1)]
        );
    }

    /// `#Rust` and `#rust` are one tag to the writer. Listed twice, there is no telling which
    /// one to type.
    #[test]
    fn spellings_that_differ_only_in_case_are_one_tag() {
        let mut tally = Tally::default();
        tally.add(Record::Note, Some(day("2026-01-02")), &tags(&["Rust"]));
        tally.add(Record::Entry, Some(day("2026-01-01")), &tags(&["rust"]));
        tally.add(Record::Entry, Some(day("2026-01-01")), &tags(&["RUST"]));

        assert_eq!(tally.finish(), vec![usage("Rust", 1, 2)]);
    }

    /// The name shown is the one the newest record uses: the spelling picked from the list
    /// is the one typed into the note, and the newest is the one the writer uses now.
    /// Records come in reading order (Scrawl days newest first, then notes newest first), so
    /// a newer one can arrive after an older one.
    #[test]
    fn a_tag_is_named_by_its_newest_spelling() {
        let mut tally = Tally::default();
        tally.add(
            Record::Entry,
            Some(day("2026-01-01")),
            &tags(&["cognitivebias"]),
        );
        tally.add(
            Record::Note,
            Some(day("2026-03-01")),
            &tags(&["CognitiveBias"]),
        );
        tally.add(
            Record::Note,
            Some(day("2025-12-01")),
            &tags(&["COGNITIVEBIAS"]),
        );

        assert_eq!(tally.finish()[0].tag, "CognitiveBias");
    }

    /// On the same day the first one read keeps the name, so the answer does not depend on
    /// which of two equal dates the map happened to see last.
    #[test]
    fn on_the_same_day_the_first_spelling_read_is_kept() {
        let mut tally = Tally::default();
        tally.add(Record::Entry, Some(day("2026-01-01")), &tags(&["memo"]));
        tally.add(Record::Note, Some(day("2026-01-01")), &tags(&["Memo"]));

        assert_eq!(tally.finish()[0].tag, "memo");
    }

    /// A note whose frontmatter has no time cannot be placed in time, so any dated record
    /// names the tag before it does.
    #[test]
    fn an_undated_note_names_a_tag_only_when_nothing_dated_does() {
        let mut tally = Tally::default();
        tally.add(Record::Note, None, &tags(&["Memo"]));
        tally.add(Record::Note, Some(day("2020-01-01")), &tags(&["memo"]));
        tally.add(Record::Note, None, &tags(&["Draft"]));

        let counted = tally.finish();
        assert_eq!(counted[0], usage("memo", 2, 0));
        assert_eq!(counted[1], usage("Draft", 1, 0));
    }

    /// Most used first; a tie goes by the folded name so the order holds still between calls.
    #[test]
    fn most_used_comes_first_and_a_tie_goes_by_name() {
        let mut tally = Tally::default();
        tally.add(
            Record::Entry,
            Some(day("2026-01-01")),
            &tags(&["b", "設計", "Zed"]),
        );
        tally.add(Record::Entry, Some(day("2026-01-01")), &tags(&["設計"]));
        tally.add(Record::Entry, Some(day("2026-01-01")), &tags(&["a"]));

        let names: Vec<String> = tally.finish().into_iter().map(|t| t.tag).collect();
        assert_eq!(names, vec!["設計", "a", "b", "Zed"]);
    }

    // ──────────── what is read ────────────

    /// One day file with these lines, laid out the way the app writes them.
    fn day_file(tmp: &TempDir, date: &str, lines: &str) {
        let dir = tmp.path().join("data/scrawl");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{date}.md")), lines).unwrap();
    }

    fn note(tmp: &TempDir, body: &str, tags: &[String]) {
        create_draft_note(
            tmp.path(),
            body,
            tags,
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();
    }

    #[test]
    fn an_empty_tree_has_no_tags() {
        let tmp = TempDir::new().unwrap();

        assert_eq!(count_tags(tmp.path()).unwrap(), Vec::new());
    }

    /// The three surfaces all count. A Codex is a note that keeps versions, so it counts in
    /// the notes column.
    #[test]
    fn entries_notes_and_codexes_all_count() {
        let tmp = TempDir::new().unwrap();
        day_file(
            &tmp,
            "2026-01-15",
            "- [09:00:00] #run 朝 {\"battery\":50}\n- [10:00:00] #run 夜\n",
        );
        note(&tmp, "設計 #run", &[]);
        create_draft_codex(
            tmp.path(),
            "# 本\n#run の記録",
            &[],
            &Context::default(),
            Provenance::default(),
        )
        .unwrap();

        assert_eq!(count_tags(tmp.path()).unwrap(), vec![usage("run", 2, 2)]);
    }

    /// A note claims its frontmatter tags as well as the body's `#tag`s (the tag field of old
    /// builds wrote the frontmatter). Code is not read, and a note naming a tag both ways
    /// counts once.
    #[test]
    fn a_note_counts_its_frontmatter_and_body_tags_once_each() {
        let tmp = TempDir::new().unwrap();
        note(&tmp, "本文 #memo `#define` #rust", &tags(&["Memo", "old"]));

        assert_eq!(
            count_tags(tmp.path()).unwrap(),
            vec![usage("Memo", 1, 0), usage("old", 1, 0), usage("rust", 1, 0)]
        );
    }

    /// A day file can carry no tag at all; a `#` only inside the context JSON is not one either.
    #[test]
    fn a_day_without_tags_adds_nothing() {
        let tmp = TempDir::new().unwrap();
        day_file(
            &tmp,
            "2026-01-15",
            "- [09:00:00] 走った {\"place\":\"#gym\"}\n",
        );
        day_file(&tmp, "2026-01-16", "- [09:00:00] C# を読む\n");

        assert_eq!(count_tags(tmp.path()).unwrap(), Vec::new());
    }

    /// The suggestions used to be counted on the screen from `browse_all`'s rows, folding the
    /// case and keeping the first spelling met. Counting here must give the same rows.
    #[test]
    fn counts_what_counting_the_browse_list_counted() {
        let tmp = TempDir::new().unwrap();
        day_file(
            &tmp,
            "2026-01-15",
            "- [09:00:00] #Run #朝\n- [10:00:00] #run\n",
        );
        day_file(&tmp, "2026-03-01", "- [09:00:00] #MEMO\n");
        note(&tmp, "# 題\n本文", &tags(&["設計"]));
        let dir = tmp.path().join("data/notes");
        let time = FixedOffset::east_opt(9 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 3, 1, 9, 0, 0)
            .unwrap();
        let old = frontmatter::render(&NoteFrontmatter::new(time), "#Memo #RUN").unwrap();
        std::fs::write(dir.join("20260301_090000.md"), old).unwrap();

        let mut by_hand: Vec<(String, usize)> = Vec::new();
        for hit in browse_all(tmp.path()).unwrap() {
            for tag in hit.tags {
                match by_hand
                    .iter_mut()
                    .find(|(seen, _)| seen.eq_ignore_ascii_case(&tag))
                {
                    Some((_, count)) => *count += 1,
                    None => by_hand.push((tag, 1)),
                }
            }
        }
        let mut counted: Vec<(String, usize)> = count_tags(tmp.path())
            .unwrap()
            .into_iter()
            .map(|t| {
                let total = t.total();
                (t.tag, total)
            })
            .collect();
        by_hand.sort();
        counted.sort();
        assert_eq!(counted, by_hand);
    }
}
