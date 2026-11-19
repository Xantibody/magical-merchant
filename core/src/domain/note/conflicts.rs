//! Copies set aside under `conflicts/`: the conflict copies an older release left in
//! `data/`, and the `notes/` side of an ID that is also a Codex.

use std::path::{Path, PathBuf};

use crate::domain::data::data_dir;
use crate::domain::note::kind::{NOTES_DIR, codex_dir, notes_dir};
use crate::services::files::{
    ensure_dir, is_file, list_md_files, rename_without_clobber, walk_files,
};
use crate::sync::conflict::{conflict_copy_path, conflict_filename};
use crate::utils::clock::UtcStamp;

/// Where the copy of the side that lost a conflict lives.
///
/// Outside `data/`. It stays out of the sync scan, and also out of the
/// `data/notes/*.md` the note list picks up. A copy is for restoring, not
/// something to line up as a note that keeps being written.
#[must_use]
pub(crate) fn conflicts_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("conflicts")
}

/// Move conflict copies that an old build put in `data/` to `conflicts/`.
///
/// Returns the count moved. The app calls it once per process at start, and the sync engine calls
/// it under the lock before every scan.
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
#[must_use]
pub fn relocate_conflict_copies(base_dir: &Path) -> usize {
    relocate_under(&data_dir(base_dir), &conflicts_dir(base_dir))
}

/// If the same ID is in both `notes/` and `codex/`, move the `notes/` side to `conflicts/`.
///
/// Returns the count moved. The sync engine calls it under the lock before the scan and again after
/// a successful run; the app also calls it once per process at start.
///
/// Promotion is a rename, so on one device both never exist at once; but if another device
/// edited the same note before syncing, sync distributes that `notes/` side as a new file.
/// The Codex side is the real one: that is where versions are committed. The losing side is
/// not deleted; it goes to `conflicts/notes/<stem>/<time>.md`, the same place as a sync
/// conflict copy.
///
/// As with `relocate_conflict_copies`, one failure does not stop it.
#[must_use]
pub fn relocate_duplicate_ids(base_dir: &Path) -> usize {
    relocate_duplicate_ids_at(base_dir, UtcStamp::now())
}

/// The variant that takes the copy's time. Split out only so a test can set up two runs in
/// the same second: what happens when second-precision names collide is the point here.
fn relocate_duplicate_ids_at(base_dir: &Path, now: UtcStamp) -> usize {
    let codex = codex_dir(base_dir);
    let conflicts = conflicts_dir(base_dir);
    let Ok(entries) = list_md_files(&notes_dir(base_dir)) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries {
        let name = entry.file_name();
        if !is_file(&codex.join(&name)) {
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

fn relocate_under(root: &Path, conflicts: &Path) -> usize {
    let mut moved = 0;
    for path in walk_files(root) {
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
        moved += 1;
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::note::{NoteFilename, Provenance, create_draft_codex};
    use crate::domain::scrawl::day::SCRAWL_DIR;
    use crate::utils::device::Context;
    use std::fs;
    use tempfile::TempDir;

    /// Copies sit outside `data/`, like history. Inside, they would travel back and
    /// forth on sync and also line up in the note list.
    #[test]
    fn conflict_copies_sit_outside_the_synced_tree() {
        assert_eq!(
            conflicts_dir(Path::new("/app")),
            PathBuf::from("/app/conflicts")
        );
    }

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
        let now = UtcStamp::new(2026, 5, 11, 3, 13, 36).unwrap();
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

    fn mock_context() -> Context {
        Context {
            battery: Some(50),
            is_charging: Some(false),
            ..Context::default()
        }
    }

    fn filename_of(path: &Path) -> NoteFilename {
        NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap()
    }

    fn codex(tmp: &TempDir, body: &str) -> PathBuf {
        create_draft_codex(
            tmp.path(),
            body,
            &[],
            &mock_context(),
            Provenance::default(),
        )
        .unwrap()
    }

    /// When a promotion and an offline edit on another device land on the same ID, sync
    /// delivers the notes/ side as a new file. The Codex side stays, and the notes/ side is
    /// set aside in the same place as conflict copies.
    #[test]
    fn a_duplicate_id_in_notes_is_moved_to_conflicts() {
        let tmp = TempDir::new().unwrap();
        let path = codex(&tmp, "codex 側");
        let filename = filename_of(&path);
        let stale = tmp.path().join("data/notes").join(filename.as_str());
        fs::create_dir_all(stale.parent().unwrap()).unwrap();
        fs::write(&stale, "notes 側").unwrap();

        assert_eq!(relocate_duplicate_ids(tmp.path()), 1);

        assert!(!stale.exists());
        assert!(fs::read_to_string(&path).unwrap().contains("codex 側"));
        let stem = filename.as_str().trim_end_matches(".md");
        let copies: Vec<_> = fs::read_dir(tmp.path().join("conflicts/notes").join(stem))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read_to_string(copies[0].path()).unwrap(), "notes 側");
        assert_eq!(relocate_duplicate_ids(tmp.path()), 0);
    }
}
