use std::fs::{self, DirEntry};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::CoreError;

pub fn ensure_dir(path: &Path) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Resolves a validated filename to the real file path directly under `dir`.
/// Validating the name alone still allows escaping `dir` through a symbolic link,
/// so it also checks that the canonicalized target sits under `dir`.
/// This is a security boundary, so it lives here only and is not copied per storage location.
pub fn resolve_existing(dir: &Path, filename: &str) -> Result<PathBuf, CoreError> {
    let path = dir.join(filename);
    if !path.exists() {
        return Err(CoreError::NotFound(path.to_string_lossy().to_string()));
    }

    let canonical_dir = fs::canonicalize(dir)?;
    let canonical_path = fs::canonicalize(&path)?;
    if !canonical_path.starts_with(&canonical_dir) {
        return Err(CoreError::PathTraversal(filename.to_string()));
    }
    Ok(canonical_path)
}

/// A running number that keeps temporary file names from colliding within one process.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Writes a temporary file in the same directory, then replaces the target by rename.
/// Overwriting directly with `fs::write` leaves a half-written file if the process
/// dies mid-write. Scrawl rewrites a whole day on every append, so that would mean
/// the corruption of the entire day's record.
/// A rename is atomic within one filesystem, so a reader sees either the old
/// content or the new, never anything else.
///
/// The name is `.sync-tmp-` so that a leftover from a crash matches the existing
/// exclusion of the sync scan, and without `.md` it does not show up in the note list.
/// It does not go as far as fsync against power loss: an fsync on every save trades
/// against battery on mobile. What is prevented here is corruption from process death.
pub fn write_atomic<C: AsRef<[u8]>>(path: &Path, contents: C) -> Result<(), CoreError> {
    let dir = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".sync-tmp-{}-{seq}", std::process::id()));

    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        // a temporary file left behind by a failed rename does not block the next
        // write, but garbage piles up. If it cannot be removed, the original error matters more.
        let _ = fs::remove_file(&tmp);
    })?;
    Ok(())
}

/// The limit at which suffixes are given up. 100 copies never line up in the same
/// second, so hitting this means a bug. Rather than hang counting, leave that one
/// item unmoved and let the next start pick it up.
const MAX_SPARE_NAMES: u32 = 100;

/// Moves `from` to `to`. If `to` is taken, puts it next door with a suffix `-2`,
/// `-3` and so on, and returns where it actually landed.
///
/// The opposite of `write_atomic`: this function's job is to never erase what is
/// already there. A copy's name only goes down to the second, so two evacuations
/// in the same second point at the same name. On Unix `fs::rename` silently
/// removes the destination, so calling it plainly loses the copy taken first. A
/// copy exists only to recover lost edits, so a copy that vanishes is the same as none.
///
/// AIDEV-NOTE: The free check is `create_new` (`O_EXCL`). `exists()` then `rename` loses in the window between looking and moving
pub fn rename_without_clobber(from: &Path, to: &Path) -> Result<PathBuf, CoreError> {
    for n in 1..=MAX_SPARE_NAMES {
        let candidate = if n == 1 {
            to.to_path_buf()
        } else {
            spare_name(to, n)
        };
        let reserved = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(e.into()),
        };
        if reserved {
            // the name is reserved. Filling it is a rename over the empty file we
            // created, so the only thing erased here is our own marker
            return fs::rename(from, &candidate)
                .map(|()| candidate.clone())
                .inspect_err(|_| {
                    let _ = fs::remove_file(&candidate);
                })
                .map_err(CoreError::from);
        }
    }
    Err(CoreError::Io(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("{} and its spare names are all taken", to.display()),
    )))
}

/// The second `a/b.md` becomes `a/b-2.md`. The extension stays: unless a copy
/// still reads as `.md`, it cannot be opened when restoring.
fn spare_name(path: &Path, n: u32) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("conflict");
    let name = path
        .extension()
        .and_then(|e| e.to_str())
        .map_or_else(|| format!("{stem}-{n}"), |ext| format!("{stem}-{n}.{ext}"));
    path.with_file_name(name)
}

/// `e.path()` allocates a `PathBuf` that includes the directory name. Just checking
/// the extension needs only the file name, so the per-entry allocation is that much smaller.
fn is_md(entry: &DirEntry) -> bool {
    Path::new(&entry.file_name())
        .extension()
        .is_some_and(|ext| ext == "md")
}

pub fn list_md_files(dir: &Path) -> Result<Vec<DirEntry>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<_> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(is_md)
        .collect();

    // file_name() allocates an OsString each time, so it is not called on every comparison.
    entries.sort_by_cached_key(|e| std::cmp::Reverse(e.file_name()));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn seed(names: &[&str]) -> TempDir {
        let tmp = TempDir::new().unwrap();
        for name in names {
            fs::write(tmp.path().join(name), "x").unwrap();
        }
        tmp
    }

    #[test]
    fn lists_only_md_files_newest_name_first() {
        let tmp = seed(&["a.md", "b.md", "c.txt", "no-extension"]);

        let names: Vec<_> = list_md_files(tmp.path())
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert_eq!(names, vec!["b.md", "a.md"]);
    }

    /// `.md` is a dotfile, not an extension. The check follows `Path::extension`, so
    /// this confirms it has not been replaced by a suffix match on the name.
    #[test]
    fn a_file_named_just_md_is_not_a_note() {
        let tmp = seed(&[".md"]);

        assert!(list_md_files(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn a_missing_directory_is_empty_rather_than_an_error() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("nope");

        assert!(list_md_files(&missing).unwrap().is_empty());
    }

    #[test]
    fn write_atomic_writes_the_contents() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");

        write_atomic(&path, "hello").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
    }

    #[test]
    fn write_atomic_replaces_what_was_there() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write_atomic(&path, "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
    }

    /// A leftover temporary file turns into a note list entry or a sync target, depending
    /// on its name.
    #[test]
    fn write_atomic_leaves_no_temp_file_behind() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("note.md");

        write_atomic(&path, "hello").unwrap();

        let names: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["note.md"]);
    }

    #[test]
    fn rename_without_clobber_moves_to_a_free_name() {
        let tmp = TempDir::new().unwrap();
        let from = tmp.path().join("a.md");
        let to = tmp.path().join("b.md");
        fs::write(&from, "body").unwrap();

        assert_eq!(rename_without_clobber(&from, &to).unwrap(), to);

        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).unwrap(), "body");
    }

    /// Even when the destination is taken, nothing is erased. A copy exists to
    /// recover lost edits, and a copy that gets overwritten is the same as none.
    #[test]
    fn rename_without_clobber_keeps_what_is_already_there() {
        let tmp = TempDir::new().unwrap();
        let from = tmp.path().join("a.md");
        let to = tmp.path().join("b.md");
        fs::write(&from, "newcomer").unwrap();
        fs::write(&to, "the one already there").unwrap();

        let landed = rename_without_clobber(&from, &to).unwrap();

        assert_eq!(landed, tmp.path().join("b-2.md"));
        assert_eq!(fs::read_to_string(&to).unwrap(), "the one already there");
        assert_eq!(fs::read_to_string(&landed).unwrap(), "newcomer");
    }

    /// The suffix counts up until a name is free. The extension is kept: without `.md` it
    /// cannot be read when restoring.
    #[test]
    fn rename_without_clobber_counts_up_until_a_name_is_free() {
        let tmp = TempDir::new().unwrap();
        let to = tmp.path().join("b.md");
        fs::write(&to, "first").unwrap();
        fs::write(tmp.path().join("b-2.md"), "second").unwrap();
        let from = tmp.path().join("a.md");
        fs::write(&from, "third").unwrap();

        let landed = rename_without_clobber(&from, &to).unwrap();

        assert_eq!(landed, tmp.path().join("b-3.md"));
        assert_eq!(fs::read_to_string(&landed).unwrap(), "third");
    }

    /// If the source is missing, nothing is left behind. Leaving the reserved name
    /// as an empty file makes the next copy read it as "taken" and keep escaping to suffixes.
    #[test]
    fn rename_without_clobber_leaves_no_placeholder_when_the_move_fails() {
        let tmp = TempDir::new().unwrap();
        let to = tmp.path().join("b.md");

        assert!(rename_without_clobber(&tmp.path().join("nope.md"), &to).is_err());

        assert!(!to.exists());
    }

    /// Even if one is left behind by a crash, it is not `.md` so it does not show in
    /// the note list, and it is `.sync-tmp-` so it matches the sync scan's existing exclusion.
    #[test]
    fn write_atomic_temp_names_are_invisible_to_md_listing() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".sync-tmp-999-0"), "orphan").unwrap();
        fs::write(tmp.path().join("real.md"), "x").unwrap();

        let names: Vec<_> = list_md_files(tmp.path())
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["real.md"]);
    }
}
