use std::fs;
use std::path::Path;

use chrono::{DateTime, FixedOffset, Local, NaiveDateTime, TimeZone as _, Utc};

use crate::error::CoreError;
use crate::sync::conflict::{conflict_copy_path, conflict_filename};
use crate::utils::frontmatter::{self, NoteFrontmatter};
use crate::utils::fs::{ensure_dir, list_md_files, rename_without_clobber, write_atomic};
use crate::utils::paths::{NOTES_DIR, codex_dir, conflicts_dir, data_dir, notes_dir};

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

/// Move conflict copies that an older release left in `data/` to `conflicts/`. Returns
/// how many were moved.
///
/// The copies were excluded from the sync scan, but the note list picks up
/// `data/notes/*.md` as is, so they stayed in the list as leftovers after the original
/// note was gone. Scrawl copies do not show in the list, but now that the scan exclusion
/// is gone, leaving them in place distributes them to every device as new files on the
/// next sync.
///
/// The whole of `data/` is searched. Since the scan syncs all of `data/`, whether a
/// leftover gets distributed does not depend on where it sits: a copy under a directory
/// the user made is treated the same as one in `notes/`.
///
/// The content is not read; it is only a `rename`. A copy can be moved even if it is
/// broken or does not look like a note. Call this at startup, before the first sync:
/// called later, the scan without the exclusion distributes the leftovers to every device
/// as new notes.
///
/// One failure does not stop it. A copy that could not be moved is simply retried on the
/// next startup, and that is no reason to give up on the rest of the move.
pub(crate) fn relocate_conflict_copies(base_dir: &Path) -> usize {
    let data = data_dir(base_dir);
    let mut moved = 0;
    relocate_under(&data, &data, &conflicts_dir(base_dir), &mut moved);
    moved
}

/// When the same ID exists in both `notes/` and `codex/`, turn the `notes/` side into a copy.
///
/// Promotion is a rename, so on one device both never exist at once; but if another device
/// edited the same note before syncing, sync distributes that `notes/` side as a new file.
/// The Codex side is the real one: that is where versions are committed. The losing side is
/// not deleted; it goes to `conflicts/notes/<stem>/<time>.md`, the same place as a sync
/// conflict copy.
///
/// As with `relocate_conflict_copies`, one failure does not stop it.
pub(crate) fn relocate_duplicate_ids(base_dir: &Path) -> usize {
    relocate_duplicate_ids_at(base_dir, Utc::now())
}

/// The variant that takes the copy's time. Split out only so a test can set up two runs in
/// the same second: what happens when second-precision names collide is the point here.
fn relocate_duplicate_ids_at(base_dir: &Path, now: DateTime<Utc>) -> usize {
    let codex = codex_dir(base_dir);
    let conflicts = conflicts_dir(base_dir);
    let Ok(entries) = list_md_files(&notes_dir(base_dir)) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries {
        let name = entry.file_name();
        if !codex.join(&name).is_file() {
            continue;
        }
        let key = format!("{NOTES_DIR}/{}", name.to_string_lossy());
        let Some(relative) = conflict_copy_path(&conflict_filename(&key, now)) else {
            continue;
        };
        let target = conflicts.join(relative);
        if ensure_dir(&target).is_err() || rename_without_clobber(&entry.path(), &target).is_err() {
            continue;
        }
        moved += 1;
    }
    moved
}

fn relocate_under(root: &Path, current: &Path, conflicts: &Path, moved: &mut usize) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            relocate_under(root, &path, conflicts, moved);
            continue;
        }
        // Shape it like a scan key before parsing. The copy lands in the same
        // `conflicts/<key>/` place as the ones that came down through a download
        let Some(relative) = path
            .strip_prefix(root)
            .ok()
            .and_then(|key| key.to_str())
            .and_then(conflict_copy_path)
        else {
            continue;
        };
        let target = conflicts.join(relative);
        if ensure_dir(&target).is_err() || rename_without_clobber(&path, &target).is_err() {
            continue;
        }
        *moved += 1;
    }
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
    DateTime::parse_from_rfc3339(time_value.trim()).ok()?;

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
fn filename_time(filename: &str) -> Option<DateTime<FixedOffset>> {
    let stem = filename.get(..15)?;
    let naive = NaiveDateTime::parse_from_str(stem, "%Y%m%d_%H%M%S").ok()?;
    let local = Local.from_local_datetime(&naive).earliest()?;
    Some(local.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::paths::{SCRAWL_DIR, notes_dir};
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
        let expected = Local
            .with_ymd_and_hms(2026, 5, 3, 15, 39, 10)
            .single()
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

    /// The leading timestamp is readable even from a sync conflict filename.
    #[test]
    fn filename_time_reads_conflict_filenames() {
        let time = filename_time("20260320_033440.sync-conflict-20260511-031336..md").unwrap();
        let expected = Local
            .with_ymd_and_hms(2026, 3, 20, 3, 34, 40)
            .single()
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

    // ──────────── Moving conflict copies ────────────

    fn seed_note(base: &Path, name: &str, content: &str) {
        let notes = notes_dir(base);
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join(name), content).unwrap();
    }

    /// Copies left by an older release remain in `data/notes/`. They show in the list, and
    /// once the scan without the exclusion picks them up they go to other devices too.
    #[test]
    fn conflict_copies_left_in_the_notes_directory_move_out() {
        let tmp = TempDir::new().unwrap();
        seed_note(tmp.path(), "20260320_033440.md", "the note itself");
        seed_note(
            tmp.path(),
            "20260320_033440.sync-conflict-20260511-031336.md",
            "first copy",
        );
        // A leftover whose original note is already gone. Most of what is on hand now is this
        seed_note(
            tmp.path(),
            "20260101_000000.sync-conflict-20260511-031336..md",
            "orphan copy",
        );

        let moved = relocate_conflict_copies(tmp.path());

        assert_eq!(moved, 2);
        let notes: Vec<String> = list_md_files(&notes_dir(tmp.path()))
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(notes, vec!["20260320_033440.md"]);
        let conflicts = conflicts_dir(tmp.path());
        assert_eq!(
            fs::read_to_string(conflicts.join("notes/20260320_033440/20260511-031336.md")).unwrap(),
            "first copy"
        );
        assert_eq!(
            fs::read_to_string(conflicts.join("notes/20260101_000000/20260511-031336.md")).unwrap(),
            "orphan copy"
        );
    }

    /// It runs on every startup. Nothing may be left that moves on the second run.
    #[test]
    fn relocating_twice_moves_nothing_the_second_time() {
        let tmp = TempDir::new().unwrap();
        seed_note(
            tmp.path(),
            "20260320_033440.sync-conflict-20260511-031336.md",
            "copy",
        );

        assert_eq!(relocate_conflict_copies(tmp.path()), 1);
        let after_first = fs::read_to_string(
            conflicts_dir(tmp.path()).join("notes/20260320_033440/20260511-031336.md"),
        )
        .unwrap();

        assert_eq!(relocate_conflict_copies(tmp.path()), 0);
        assert_eq!(
            fs::read_to_string(
                conflicts_dir(tmp.path()).join("notes/20260320_033440/20260511-031336.md")
            )
            .unwrap(),
            after_first
        );
    }

    /// Scrawl copies are the same kind of leftover. They do not show in the list (a name
    /// that is not a date is discarded), but now that the scan exclusion is gone, leaving
    /// them in place distributes them to every device as new files on the next sync.
    #[test]
    fn conflict_copies_left_in_the_scrawl_directory_move_out() {
        let tmp = TempDir::new().unwrap();
        let scrawl = data_dir(tmp.path()).join(SCRAWL_DIR);
        fs::create_dir_all(&scrawl).unwrap();
        fs::write(scrawl.join("2026-03-20.md"), "the day itself").unwrap();
        fs::write(
            scrawl.join("2026-03-20.sync-conflict-20260511-031336..md"),
            "day copy",
        )
        .unwrap();

        assert_eq!(relocate_conflict_copies(tmp.path()), 1);

        assert!(scrawl.join("2026-03-20.md").exists());
        assert!(
            !scrawl
                .join("2026-03-20.sync-conflict-20260511-031336..md")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(
                conflicts_dir(tmp.path()).join("scrawl/2026-03-20/20260511-031336.md")
            )
            .unwrap(),
            "day copy"
        );
    }

    /// Copies pile up not only in `notes/` and `scrawl/`. Everything under `data/` is in
    /// the sync scan, so a copy left in a directory the user made is also distributed to
    /// every device as a new file if left in place.
    #[test]
    fn conflict_copies_in_a_nested_directory_move_out() {
        let tmp = TempDir::new().unwrap();
        let done = data_dir(tmp.path()).join("projects/aaaa/done");
        fs::create_dir_all(&done).unwrap();
        fs::write(done.join("20260417_023550_461.md"), "the entry").unwrap();
        fs::write(
            done.join("20260417_023550_461.sync-conflict-20260511-031336..md"),
            "nested copy",
        )
        .unwrap();

        assert_eq!(relocate_conflict_copies(tmp.path()), 1);

        assert!(done.join("20260417_023550_461.md").exists());
        assert!(
            !done
                .join("20260417_023550_461.sync-conflict-20260511-031336..md")
                .exists()
        );
        assert_eq!(
            fs::read_to_string(
                conflicts_dir(tmp.path())
                    .join("projects/aaaa/done/20260417_023550_461/20260511-031336.md")
            )
            .unwrap(),
            "nested copy"
        );
    }

    /// The move does not look at content. A copy is moved even if broken or not a note.
    #[test]
    fn a_note_that_is_not_a_conflict_copy_stays_put() {
        let tmp = TempDir::new().unwrap();
        seed_note(tmp.path(), "20260320_033440.md", "body");

        assert_eq!(relocate_conflict_copies(tmp.path()), 0);
        assert!(notes_dir(tmp.path()).join("20260320_033440.md").exists());
        assert!(!conflicts_dir(tmp.path()).exists());
    }

    // ──────────── Moving duplicate IDs ────────────

    fn seed_codex(base: &Path, name: &str, content: &str) {
        let codex = codex_dir(base);
        fs::create_dir_all(&codex).unwrap();
        fs::write(codex.join(name), content).unwrap();
    }

    fn conflict_copies(base: &Path, stem: &str) -> Vec<String> {
        let dir = conflicts_dir(base).join(NOTES_DIR).join(stem);
        let mut found: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| fs::read_to_string(e.path()).unwrap())
            .collect();
        found.sort();
        found
    }

    /// One sync runs it twice: at the entry and right before success. The download in
    /// between puts the same ID back in `notes/`, so setting aside twice in the same second
    /// actually happens. A copy's name only goes down to the second, so the second target
    /// is the same as the first. A plain `rename` there silently loses the first copy on Unix.
    #[test]
    fn a_second_relocation_in_the_same_second_keeps_the_first_copy() {
        let tmp = TempDir::new().unwrap();
        let now = Utc.with_ymd_and_hms(2026, 5, 11, 3, 13, 36).unwrap();
        seed_codex(tmp.path(), "20260320_033440.md", "the codex");
        seed_note(tmp.path(), "20260320_033440.md", "the offline edit");

        assert_eq!(relocate_duplicate_ids_at(tmp.path(), now), 1);
        // The download put the same ID in `notes/` once more
        seed_note(tmp.path(), "20260320_033440.md", "the downloaded one");
        assert_eq!(relocate_duplicate_ids_at(tmp.path(), now), 1);

        assert_eq!(
            conflict_copies(tmp.path(), "20260320_033440"),
            vec!["the downloaded one", "the offline edit"]
        );
        assert!(!notes_dir(tmp.path()).join("20260320_033440.md").exists());
        assert!(codex_dir(tmp.path()).join("20260320_033440.md").exists());
    }

    /// The old name (one extra dot) and the current name point at the same copy. Both go to
    /// `notes/<stem>/<time>.md`, so they collide within the same move.
    #[test]
    fn two_copies_of_the_same_second_both_survive_the_move() {
        let tmp = TempDir::new().unwrap();
        seed_note(
            tmp.path(),
            "20260320_033440.sync-conflict-20260511-031336.md",
            "new shape",
        );
        seed_note(
            tmp.path(),
            "20260320_033440.sync-conflict-20260511-031336..md",
            "old shape",
        );

        assert_eq!(relocate_conflict_copies(tmp.path()), 2);

        assert_eq!(
            conflict_copies(tmp.path(), "20260320_033440"),
            vec!["new shape", "old shape"]
        );
    }
}
