//! A one-time repair of notes an older editor build saved with mangled metadata.

use std::fs;
use std::path::Path;

use crate::domain::note::NoteFrontmatter;
use crate::domain::note::kind::notes_dir;
use crate::error::CoreError;
use crate::services::files::{list_md_files, write_atomic};
use crate::utils::clock::{Stamp, WallClock, Zone};
use crate::utils::frontmatter;

/// Repair garbled metadata that past edits mixed into the body. Returns the number of
/// files repaired.
pub fn repair_notes(base_dir: &Path) -> Result<usize, CoreError> {
    repair_all(&notes_dir(base_dir))
}

/// Notes saved while the editor screen passed the frontmatter through Milkdown carry
/// "mangled metadata" at the head of the body. The opening `---` became `***`, the YAML
/// became escaped plain text (`tags: \[]`), and the closing delimiter merged with the line
/// before it into a setext heading underline (`------`); the frontmatter time was also
/// overwritten with the edit time. Remove that block and reset time to the creation time
/// in the filename.
///
/// Files that do not match are never written. Rewriting every file counts as a changed
/// content hash, and sync would re-transfer even unchanged notes.
pub(crate) fn repair_all(notes_dir: &Path) -> Result<usize, CoreError> {
    let mut repaired = 0;
    for entry in list_md_files(notes_dir)? {
        let path = entry.path();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok((fm, body)) = frontmatter::parse::<NoteFrontmatter>(&content) else {
            continue;
        };
        let Some(clean_body) = strip_mangled_metadata(body) else {
            continue;
        };

        let filename = entry.file_name().to_string_lossy().to_string();
        let fixed = NoteFrontmatter {
            time: filename_time(&filename).unwrap_or(fm.time),
            ..fm
        };
        write_atomic(&path, frontmatter::render(&fixed, &clean_body)?)?;
        repaired += 1;
    }
    Ok(repaired)
}

/// Return the body with the mangled metadata block at its head removed. `None` if there is
/// no block.
///
/// A user can write both `***` and a line starting with `time:`, so it counts as a block
/// only when all three are present: the opening delimiter, a time line that parses as a
/// time, and a closing line of dashes only.
fn strip_mangled_metadata(body: &str) -> Option<String> {
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0;

    while lines.get(i).is_some_and(|l| l.trim().is_empty()) {
        i += 1;
    }
    if lines.get(i) != Some(&"***") {
        return None;
    }
    i += 1;
    while lines.get(i).is_some_and(|l| l.trim().is_empty()) {
        i += 1;
    }

    let time_value = lines.get(i)?.strip_prefix("time: ")?;
    Stamp::parse_strict(time_value.trim()).ok()?;

    // What is left of the closing delimiter: a line of three or more dashes only
    let is_dash_line = |l: &str| l.len() >= 3 && l.bytes().all(|b| b == b'-');
    while i < lines.len() && !is_dash_line(lines[i]) {
        i += 1;
    }
    if i == lines.len() {
        return None;
    }
    i += 1;

    // The blank lines and `<br />` (what is left of empty paragraphs) right after the block
    // are not wanted in the body either
    while lines
        .get(i)
        .is_some_and(|l| l.trim().is_empty() || l.trim() == "<br />")
    {
        i += 1;
    }

    Some(lines[i..].join("\n"))
}

/// Read the creation time from a filename like `20260503_153910.md`.
/// The frontmatter time has a history of being overwritten by edits,
/// but the filename stays as assigned at creation.
fn filename_time(filename: &str) -> Option<Stamp> {
    filename_time_in(filename, &Zone::local())
}

/// [`filename_time`] read in `zone`, as chrono read it ([`Zone::earliest`]). A wall clock a
/// clock change skips over gives `None` (the caller keeps the time it has), one it repeats
/// gives the later instant.
fn filename_time_in(filename: &str, zone: &Zone) -> Option<Stamp> {
    let stem = filename.get(..15)?;
    zone.earliest(WallClock::parse_id_stem(stem).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A reproduction in the same shape as a file that was actually broken.
    const MANGLED: &str = concat!(
        "---\n",
        "time: 2026-08-09T20:38:50.370362+09:00\n",
        "tags:\n",
        "- keep\n",
        "context:\n",
        "  battery: 100\n",
        "  is_charging: true\n",
        "---\n",
        "***\n",
        "\n",
        "time: 2026-05-03T15:47:06.544569369+09:00\n",
        "tags: \\[]\n",
        "context:\n",
        "battery: 64\n",
        "is\\_charging: false\n",
        "os\\_version: '26.6'\n",
        "locale: ja\\_JP\n",
        "--------------\n",
        "\n",
        "<br />\n",
        "\n",
        "<br />\n",
        "\n",
        "# EVOJについて\n",
        "本文はここから\n",
    );

    fn seed(dir: &Path, name: &str, content: &str) {
        fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn repairs_a_mangled_note_and_restores_the_filename_time() {
        let tmp = TempDir::new().unwrap();
        seed(tmp.path(), "20260503_153910.md", MANGLED);

        let repaired = repair_all(tmp.path()).unwrap();

        assert_eq!(repaired, 1);
        let content = fs::read_to_string(tmp.path().join("20260503_153910.md")).unwrap();
        let (fm, body) = frontmatter::parse::<NoteFrontmatter>(&content).unwrap();
        assert_eq!(body, "# EVOJについて\n本文はここから");
        assert_eq!(fm.tags, vec!["keep"]);
        assert!(fm.context.is_some());
        let expected = Zone::local()
            .earliest(WallClock::new(2026, 5, 3, 15, 39, 10).unwrap())
            .unwrap();
        assert_eq!(fm.time, expected);
    }

    #[test]
    fn repair_is_idempotent() {
        let tmp = TempDir::new().unwrap();
        seed(tmp.path(), "20260503_153910.md", MANGLED);

        repair_all(tmp.path()).unwrap();
        let after_first = fs::read_to_string(tmp.path().join("20260503_153910.md")).unwrap();
        let repaired = repair_all(tmp.path()).unwrap();

        assert_eq!(repaired, 0);
        let after_second = fs::read_to_string(tmp.path().join("20260503_153910.md")).unwrap();
        assert_eq!(after_first, after_second);
    }

    /// A `***` (horizontal rule) the user wrote in the body must not be mistaken for
    /// mangled metadata and removed.
    #[test]
    fn a_user_written_horizontal_rule_is_not_metadata() {
        let tmp = TempDir::new().unwrap();
        let content = "---\ntime: 2026-04-30T02:01:21+09:00\ntags: []\n---\nあ\n\n***\n\n本文\n";
        seed(tmp.path(), "20260430_020116.md", content);

        let repaired = repair_all(tmp.path()).unwrap();

        assert_eq!(repaired, 0);
        assert_eq!(
            fs::read_to_string(tmp.path().join("20260430_020116.md")).unwrap(),
            content
        );
    }

    /// Even right after `***`, a following line that does not parse as a datetime means no block.
    #[test]
    fn a_rule_followed_by_plain_text_is_left_alone() {
        let tmp = TempDir::new().unwrap();
        let content =
            "---\ntime: 2026-04-30T02:01:21+09:00\ntags: []\n---\n***\n\ntime: 未定\n---\n";
        seed(tmp.path(), "20260430_020116.md", content);

        assert_eq!(repair_all(tmp.path()).unwrap(), 0);
    }

    /// What counts as a real `time:` line is chrono's strict RFC 3339 parser: seconds
    /// required, any number of fraction digits, `T` / `t` / space, `Z` / `z` / `±HH:MM`.
    /// A wider check would strip a user's own lines as metadata.
    #[test]
    fn strict_time_line_check_is_unchanged() {
        for (value, is_time) in [
            ("2026-03-20T14:30:45+09:00", true),
            ("2026-03-20T14:30:45.370362+09:00", true),
            ("2026-03-20T14:30:45.544569369+09:00", true),
            ("2026-03-20T14:30:45.1234567891+09:00", true),
            ("2026-03-20T14:30:60+09:00", true),
            ("2026-03-20 14:30:45+09:00", true),
            ("2026-03-20t14:30:45+09:00", true),
            ("2026-03-20T05:30:45z", true),
            ("2026-03-20T09:30:45\u{2212}05:00", true),
            ("2026-03-20T14:30+09:00", false),
            ("2026-03-20", false),
            ("2026-03-20T14:30:45+0900", false),
            ("2026-03-20T05:30:45 UTC", false),
            ("2026-3-2T4:3:5+09:00", false),
            ("2026-03-20T14:30:45.+09:00", false),
            ("2026-03-20T14:30:45+24:00", false),
            ("+10000-01-01T00:00:00Z", false),
        ] {
            let body = format!("***\n\ntime: {value}\n---\nrest");
            assert_eq!(
                strip_mangled_metadata(&body).is_some(),
                is_time,
                "value: {value:?}"
            );
        }
    }

    /// The leading timestamp is readable even from a sync conflict filename.
    #[test]
    fn filename_time_reads_conflict_filenames() {
        let time = filename_time("20260320_033440.sync-conflict-20260511-031336..md").unwrap();
        let expected = Zone::local()
            .earliest(WallClock::new(2026, 3, 20, 3, 34, 40).unwrap())
            .unwrap();
        assert_eq!(time, expected);
    }

    #[test]
    fn filename_time_rejects_foreign_names() {
        assert!(filename_time("readme.md").is_none());
    }

    #[test]
    fn a_missing_directory_repairs_nothing() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(repair_all(&tmp.path().join("nope")).unwrap(), 0);
    }
}
