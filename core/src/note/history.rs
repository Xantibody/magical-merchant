//! A snapshot of the whole text of a note, taken before it is rewritten.
//!
//! A person rewriting on screen does not need it: what vanishes in front of them is only
//! their own text. A rewrite from outside (MCP) happens where the owner is not looking,
//! so "it can be undone" is the condition for letting it write.
//!
//! The location is outside `data/`. On sync, every rewrite would send the snapshot back
//! and forth between devices, and snapshots of snapshots would pile up. It is a fallback,
//! not a derivative, so unlike `places.json` it cannot be rebuilt when broken; but losing
//! it only hurts when one wants to restore, and the note itself is still there then.
//!
//! The most recent [`KEEP`] per note are kept. The snapshots stay even when the note itself
//! is deleted: restoring a deleted note from its snapshot is the reason for taking one.
//!
//! Codex versions are a different thing and live in [`super::version`]. Those a person
//! commits, and they sync as part of the document. These a machine sets aside, and they
//! stay on the device.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, NaiveDateTime};
use serde::Serialize;

use crate::error::CoreError;
use crate::note::repository::Notes;
use crate::note::revision::Revision;
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::paths::{history_dir, notes_dir};
use crate::utils::validated::NoteFilename;

/// The number of snapshots kept per note. A branch number within the same second counts
/// as one too.
///
/// It is not cut by age, so that a note opened after a long time does not find all its
/// snapshots gone. What one wants back is usually one of the last few. 20 is well above
/// the number of rewrites MCP makes in one session.
const KEEP: usize = 20;

/// One snapshot. `id` is passed to `restore` as it is.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Snapshot {
    /// `YYYYMMDD_HHMMSS`; the second and later ones in the same second continue as `-2` `-3`.
    pub id: String,
    /// The time the snapshot was taken. Distinct from the note's `time` (creation) and
    /// `updated` (last edit): it is "the moment this content was last in effect".
    pub time: DateTime<Local>,
    pub bytes: u64,
}

fn note_history_dir(base_dir: &Path, filename: &NoteFilename) -> PathBuf {
    history_dir(base_dir).join(filename.as_str().trim_end_matches(".md"))
}

/// Only a datetime and its branch number pass as a snapshot name. An id containing `..`
/// or `/` must not read or write outside the history.
fn snapshot_path(dir: &Path, id: &str) -> Result<PathBuf, CoreError> {
    let (stamp, suffix) = id.split_once('-').unwrap_or((id, "1"));
    let well_formed = NaiveDateTime::parse_from_str(stamp, "%Y%m%d_%H%M%S").is_ok()
        && !suffix.is_empty()
        && suffix.bytes().all(|b| b.is_ascii_digit());
    if !well_formed {
        return Err(CoreError::PathTraversal(id.to_string()));
    }
    Ok(dir.join(format!("{id}.md")))
}

/// Take a snapshot of the current whole text. If the note does not exist yet, take
/// nothing and return `None`.
///
/// It copies the file whole, frontmatter included. Keeping only the body and restoring
/// it would let the metadata at the moment of restore claim to be "before the rewrite".
pub fn snapshot_note(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Option<Snapshot>, CoreError> {
    // The location does not matter. A note turned into a Codex is snapshotted under the same ID
    let path = match Notes::new(base_dir.to_path_buf()).locate(filename) {
        Ok((_, path)) => path,
        Err(CoreError::NotFound(_)) => return Ok(None),
        Err(e) => return Err(e),
    };
    let content = fs::read_to_string(&path)?;
    let dir = note_history_dir(base_dir, filename);
    let now = Local::now();
    let stamp = now.format("%Y%m%d_%H%M%S").to_string();

    // Two rewrites in the same second do not clobber the earlier snapshot. What one wants
    // back is usually the one just before a run of mistakes.
    let mut id = stamp.clone();
    let mut n = 1;
    while dir.join(format!("{id}.md")).exists() {
        n += 1;
        id = format!("{stamp}-{n}");
    }
    let target = dir.join(format!("{id}.md"));
    ensure_dir(&target)?;
    write_atomic(&target, &content)?;
    prune(&dir, &id);
    Ok(Some(Snapshot {
        id,
        time: now,
        bytes: content.len() as u64,
    }))
}

/// The (second, branch number) pair for sorting. Only the branch number is compared as a
/// number: as a string, `-10` falls before `-2` as soon as the same second reaches two digits.
///
/// The branch number is not zero-padded. If the name changed with the digit count, the ids
/// of snapshots already on disk would come in two shapes, old and new. Fixing only the
/// sorting side keeps the names immutable.
fn sort_key(id: &str) -> (&str, u32) {
    let (stamp, suffix) = id.split_once('-').unwrap_or((id, "1"));
    (stamp, suffix.parse().unwrap_or(0))
}

/// Drop whatever exceeds `KEEP`, oldest first. It is called only right after one snapshot
/// is written: tying the cleanup to the write means no directory is left piled up with
/// nobody coming back to it.
///
/// The `written` one just taken is counted but never dropped. Numbering takes "the first
/// free slot", so a bare stamp freed by cleanup and retaken in the same second sorts as
/// the oldest of that second in `sort_key`. The same happens when the clock goes back.
/// The caller returns that id as "a snapshot to restore from", so it must not be gone
/// right after it is returned.
///
/// Failures are ignored. The snapshot itself is already taken, and whatever could not be
/// dropped is dropped again on the next snapshot. A failed cleanup is no reason to stop
/// the rewrite.
fn prune(dir: &Path, written: &str) {
    let Ok(entries) = list_md_files(dir) else {
        return;
    };
    // list_md_files orders by name, so the branch number is still a string. The drop
    // order is decided again with the same `sort_key` the list uses.
    let mut others: Vec<(String, PathBuf)> = entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = Path::new(&name).file_stem()?.to_str()?.to_string();
            Some((id, entry.path()))
        })
        .filter(|(id, _)| id != written)
        .collect();
    others.sort_by(|a, b| sort_key(&b.0).cmp(&sort_key(&a.0)));
    for (_, path) in others.iter().skip(KEEP - 1) {
        let _ = fs::remove_file(path);
    }
}

/// Newest first.
pub fn list_note_history(
    base_dir: &Path,
    filename: &NoteFilename,
) -> Result<Vec<Snapshot>, CoreError> {
    let dir = note_history_dir(base_dir, filename);
    let mut snapshots: Vec<Snapshot> = list_md_files(&dir)?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let id = Path::new(&name).file_stem()?.to_str()?.to_string();
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some(Snapshot {
                id,
                time: modified.into(),
                bytes: entry.metadata().ok()?.len(),
            })
        })
        .collect();
    // The id is the time itself, so name order is time order. mtime is the time of the
    // copy destination and cannot order branch numbers within the same second.
    snapshots.sort_by(|a, b| sort_key(&b.id).cmp(&sort_key(&a.id)));
    Ok(snapshots)
}

/// The whole text of a snapshot. A reader that wants only the body strips the frontmatter.
pub fn read_note_history(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
) -> Result<String, CoreError> {
    let path = snapshot_path(&note_history_dir(base_dir, filename), id)?;
    if !path.exists() {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }
    Ok(fs::read_to_string(path)?)
}

/// Write a snapshot's content back into the note. The current whole text is snapshotted
/// before restoring, so the restore itself can be undone.
///
/// `expected` is the revision of the body as it was read. A restore is also a write that
/// replaces the whole body, so it goes through the same check as [`crate::update_note`]:
/// text typed in the app between reading the history and restoring must not vanish without
/// notice. `None` is kept for callers that restore without reading (restoring a deleted note
/// from its snapshot).
pub fn restore_note(
    base_dir: &Path,
    filename: &NoteFilename,
    id: &str,
    expected: Option<&Revision>,
) -> Result<Option<Snapshot>, CoreError> {
    let content = read_note_history(base_dir, filename, id)?;
    if let Some(expected) = expected {
        // An unreadable (deleted) note is refused as a mismatch too. Holding a revision
        // means something that existed was read
        let current = Notes::new(base_dir.to_path_buf())
            .read(filename)
            .ok()
            .map(|body| Revision::of(&body));
        if current.as_ref() != Some(expected) {
            return Err(CoreError::Stale(filename.as_str().to_string()));
        }
    }
    let before = snapshot_note(base_dir, filename)?;
    // Restore to where it is now. Writing a Codex's snapshot into `notes/` would spawn a
    // plain note with the same ID beside it. A deleted note's snapshot goes back to `notes/`
    let target = match Notes::new(base_dir.to_path_buf()).locate(filename) {
        Ok((_, path)) => path,
        Err(CoreError::NotFound(_)) => notes_dir(base_dir).join(filename.as_str()),
        Err(e) => return Err(e),
    };
    ensure_dir(&target)?;
    write_atomic(&target, content)?;
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::device::Context;
    use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};
    use crate::{create_draft_note, promote_note_to_codex, read_note_by_filename, update_note};
    use tempfile::TempDir;

    /// A note turned into a Codex is snapshotted under the same ID, and restores into the
    /// Codex location. Restoring into `notes/` would spawn a plain note with the same ID beside it.
    #[test]
    fn a_codex_is_snapshotted_and_restored_where_it_lives() {
        let tmp = TempDir::new().unwrap();
        let (old_path, filename) = note(tmp.path(), "before");
        promote_note_to_codex(tmp.path(), &filename).unwrap();
        let codex_path = tmp.path().join("data/codex").join(filename.as_str());

        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&codex_path, "after", &Context::default(), None).unwrap();
        restore_note(tmp.path(), &filename, &snap.id, None).unwrap();

        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
        assert!(codex_path.exists());
        assert!(!old_path.exists());
    }

    fn note(base: &Path, body: &str) -> (PathBuf, NoteFilename) {
        let path =
            create_draft_note(base, body, &[], &Context::default(), Provenance::default()).unwrap();
        let filename = NoteFilename::parse(path.file_name().unwrap().to_str().unwrap()).unwrap();
        (path, filename)
    }

    #[test]
    fn a_note_that_does_not_exist_leaves_nothing_behind() {
        let tmp = TempDir::new().unwrap();
        let filename = NoteFilename::parse("20260101_000000.md").unwrap();

        assert_eq!(snapshot_note(tmp.path(), &filename).unwrap(), None);
        assert!(list_note_history(tmp.path(), &filename).unwrap().is_empty());
    }

    /// A snapshot is the file itself, not the body. Restoring a snapshot without its
    /// frontmatter would lose the creation time and the tags.
    #[test]
    fn a_snapshot_is_the_whole_file_frontmatter_included() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");

        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        let stored = read_note_history(tmp.path(), &filename, &snap.id).unwrap();
        assert_eq!(stored, fs::read_to_string(&path).unwrap());
        assert!(stored.starts_with("---\n"));
    }

    #[test]
    fn restoring_brings_the_old_body_back_and_keeps_a_way_back() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();

        let undo = restore_note(tmp.path(), &filename, &snap.id, None)
            .unwrap()
            .unwrap();

        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
        // The "after" from just before the restore is kept as a snapshot too
        let content = read_note_history(tmp.path(), &filename, &undo.id).unwrap();
        assert!(content.ends_with("after"));
    }

    /// Text typed in the app between reading the history and restoring must not be lost.
    /// From MCP's side a restore is also "a write that replaces the whole body"; if only this
    /// path let through what `update_note` refuses, the same writer could clobber the same
    /// note with no guard.
    #[test]
    fn restoring_over_a_body_that_moved_since_it_was_read_is_refused() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "first");
        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "second", &Context::default(), None).unwrap();
        // This is what the agent read
        let read = Revision::of("second");
        // The app typed after the read
        update_note(&path, "third", &Context::default(), None).unwrap();

        let result = restore_note(tmp.path(), &filename, &snap.id, Some(&read));

        assert!(matches!(result, Err(CoreError::Stale(ref name)) if name == filename.as_str()));
        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "third"
        );
        assert_eq!(
            list_note_history(tmp.path(), &filename).unwrap().len(),
            1,
            "断られた復元は控えを増やさない"
        );
    }

    /// Restoring with the revision as read goes through. What comes back is the snapshot
    /// from just before the restore.
    #[test]
    fn restoring_with_the_revision_it_read_goes_through() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "first");
        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "second", &Context::default(), None).unwrap();

        let undo = restore_note(
            tmp.path(),
            &filename,
            &snap.id,
            Some(&Revision::of("second")),
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            read_note_by_filename(tmp.path(), &filename).unwrap(),
            "first"
        );
        assert!(
            read_note_history(tmp.path(), &filename, &undo.id)
                .unwrap()
                .ends_with("second")
        );
    }

    /// When rewritten twice in the same second, the first snapshot is not clobbered by the second.
    #[test]
    fn two_snapshots_in_the_same_second_both_survive() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "one");

        let first = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "two", &Context::default(), None).unwrap();
        let second = snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        assert_ne!(first.id, second.id);
        let history = list_note_history(tmp.path(), &filename).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, second.id, "newest first");
        assert!(
            read_note_history(tmp.path(), &filename, &first.id)
                .unwrap()
                .ends_with("one")
        );
    }

    /// Once the branch number reaches two digits, string order leaves time order
    /// (`-10` < `-2`). The head of the list is "the one just before, the one to restore", so
    /// if that swaps, the default restore candidate becomes the snapshot from 9 steps back.
    ///
    /// The snapshots are placed directly rather than by calling `snapshot_note` 11 times.
    /// If the second changes during the 11 calls, the branch numbers restart and the
    /// premise of the ordering itself is gone.
    #[test]
    fn eleven_snapshots_in_the_same_second_are_listed_newest_first() {
        let tmp = TempDir::new().unwrap();
        let filename = NoteFilename::parse("20260101_000000.md").unwrap();
        let dir = note_history_dir(tmp.path(), &filename);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("20260101_120000.md"), "x").unwrap();
        for n in 2..=11 {
            fs::write(dir.join(format!("20260101_120000-{n}.md")), "x").unwrap();
        }

        let ids: Vec<String> = list_note_history(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();

        assert_eq!(ids[0], "20260101_120000-11");
        assert_eq!(ids[1], "20260101_120000-10");
        assert_eq!(ids.last().unwrap(), "20260101_120000");
    }

    /// Setup for placing snapshots directly. Calling `snapshot_note` in a row lets the second
    /// change midway, the branch numbers restart, and the count being tested is lost.
    fn seed_history(base: &Path, filename: &NoteFilename, ids: &[String]) -> PathBuf {
        let dir = note_history_dir(base, filename);
        fs::create_dir_all(&dir).unwrap();
        for id in ids {
            fs::write(dir.join(format!("{id}.md")), "x").unwrap();
        }
        dir
    }

    /// If they only piled up, one device's disk would keep filling with every AI rewrite.
    /// Whatever exceeds the limit drops, oldest first.
    #[test]
    fn twenty_one_snapshots_keep_the_newest_twenty() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");
        let ids: Vec<String> = std::iter::once("20200101_120000".to_string())
            .chain((2..=20).map(|n| format!("20200101_120000-{n}")))
            .collect();
        seed_history(tmp.path(), &filename, &ids);

        snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        let listed: Vec<String> = list_note_history(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(listed.len(), KEEP);
        assert!(
            !listed.contains(&"20200101_120000".to_string()),
            "the oldest copy is the one that goes"
        );
        assert_eq!(listed.last().unwrap(), "20200101_120000-2");
    }

    /// The drop order is decided by `sort_key` too. In string order `-10` would count as
    /// older than `-2`, and a note rewritten 10 times in one second would drop the wrong snapshot.
    #[test]
    fn the_oldest_branch_number_is_the_one_dropped() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");
        let ids: Vec<String> = (2..=21).map(|n| format!("20200101_120000-{n}")).collect();
        seed_history(tmp.path(), &filename, &ids);

        snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        let listed: Vec<String> = list_note_history(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(listed.len(), KEEP);
        assert!(!listed.contains(&"20200101_120000-2".to_string()));
        assert!(listed.contains(&"20200101_120000-10".to_string()));
    }

    /// The snapshot just written can sort as the oldest in `sort_key`: when a bare stamp
    /// freed by cleanup is retaken in the same second, or when the clock goes back. Even
    /// then the file of the returned id must not be gone. Here 20 future stamps are seeded
    /// to build the situation where "the new snapshot sorts oldest".
    #[test]
    fn the_copy_just_written_survives_even_when_it_sorts_oldest() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");
        let ids: Vec<String> = std::iter::once("20990101_120000".to_string())
            .chain((2..=KEEP).map(|n| format!("20990101_120000-{n}")))
            .collect();
        seed_history(tmp.path(), &filename, &ids);

        let written = snapshot_note(tmp.path(), &filename).unwrap().unwrap();

        let listed: Vec<String> = list_note_history(tmp.path(), &filename)
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(listed.len(), KEEP);
        assert!(
            listed.contains(&written.id),
            "the copy just taken must outlive its own prune: {listed:?}"
        );
        assert!(!listed.contains(&"20990101_120000".to_string()));
    }

    /// The snapshot location is outside the sync scan. Inside it, snapshots would go back
    /// and forth between devices.
    #[test]
    fn history_lives_outside_the_synced_data_dir() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        snapshot_note(tmp.path(), &filename).unwrap();

        let synced = crate::sync::scan::scan_local_files(tmp.path()).unwrap();
        assert_eq!(synced.len(), 1, "only the note itself is scanned");
        assert!(tmp.path().join("history").is_dir());
    }

    #[test]
    fn an_id_that_is_not_a_timestamp_is_refused() {
        let tmp = TempDir::new().unwrap();
        let (_, filename) = note(tmp.path(), "body");

        for bad in [
            "../../etc/passwd",
            "20260101_000000-",
            "latest",
            "20260101_000000-x",
        ] {
            assert!(
                read_note_history(tmp.path(), &filename, bad).is_err(),
                "{bad} should be refused"
            );
        }
    }

    /// A restored note's frontmatter is the one from the snapshot. If `updated` advanced on
    /// every restore, "the time of the last rewrite" would be a lie.
    #[test]
    fn restoring_does_not_touch_the_frontmatter_it_restores() {
        let tmp = TempDir::new().unwrap();
        let (path, filename) = note(tmp.path(), "before");
        let snap = snapshot_note(tmp.path(), &filename).unwrap().unwrap();
        update_note(&path, "after", &Context::default(), None).unwrap();

        restore_note(tmp.path(), &filename, &snap.id, None).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        let (fm, _) = frontmatter::parse::<NoteFrontmatter>(&content).unwrap();
        assert_eq!(fm.updated, None);
    }
}
