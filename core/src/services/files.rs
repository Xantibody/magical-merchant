use std::ffi::OsString;
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
///
/// Validating the name alone still allows escaping `dir` through a symbolic link, so it also checks
/// that the canonicalized target sits under `dir`. This is a security boundary, so it lives here
/// only and is not copied per storage location.
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

/// The path a validated filename will be written to directly under `dir`, creating `dir` first.
///
/// The writing side of [`resolve_existing`], and a security boundary in the same way: the
/// directory is canonicalized before the name is joined on, so a link in the directory's own
/// path is resolved here and the name, already validated, cannot climb out of it.
pub fn resolve_writable(dir: &Path, filename: &str) -> Result<PathBuf, CoreError> {
    fs::create_dir_all(dir)?;
    Ok(fs::canonicalize(dir)?.join(filename))
}

/// One item directly under a directory: its name and its size in bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub name: String,
    pub bytes: u64,
}

/// What sits directly under `dir`, in no particular order. Directories are items too.
///
/// A missing directory is empty rather than an error. An item that cannot be read, or whose
/// size cannot be taken, is skipped silently: one bad entry does not hide the rest.
pub fn list_entries(dir: &Path) -> Result<Vec<Listed>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            Some(Listed {
                name: entry.file_name().to_string_lossy().to_string(),
                bytes: entry.metadata().ok()?.len(),
            })
        })
        .collect())
}

/// The names of what sits directly under `dir`, in no particular order. Directories are
/// items too.
///
/// A missing directory is empty rather than an error, and an item that cannot be read is
/// skipped silently. Unlike [`list_entries`] it takes no item's size, so an item is never
/// dropped for want of one.
pub fn entry_names(dir: &Path) -> Result<Vec<String>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    Ok(fs::read_dir(dir)?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect())
}

/// The names of what sits directly under `dir`, read one at a time as the caller walks them.
///
/// A name is kept as the OS gave it, so `dir.join(name)` reaches the item even when the
/// name is not UTF-8. An item that cannot be read comes through as an error, for the
/// caller to stop on; a missing directory is an error too.
pub fn entries(dir: &Path) -> Result<impl Iterator<Item = Result<OsString, CoreError>>, CoreError> {
    Ok(fs::read_dir(dir)?.map(|entry| Ok(entry?.file_name())))
}

/// How many items sit directly under `dir`, counting the ones that cannot be read.
pub fn count_entries(dir: &Path) -> Result<usize, CoreError> {
    Ok(fs::read_dir(dir)?.count())
}

/// Whether anything is at `path`. A broken link or an unreadable parent reads as nothing.
#[must_use]
pub fn exists(path: &Path) -> bool {
    path.exists()
}

/// Whether the item at `path` is marked read-only, following links. Nothing there, or
/// nothing that can be looked at, is not read-only.
#[must_use]
pub fn is_read_only(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.permissions().readonly())
}

/// Whether `path` is a directory, following links.
#[must_use]
pub fn is_dir(path: &Path) -> bool {
    path.is_dir()
}

/// Moves `from` to `to`. Whatever sits at `to` is replaced where the platform allows it;
/// see [`rename_no_replace`] and [`rename_without_clobber`] for the moves that keep it.
pub fn rename(from: &Path, to: &Path) -> Result<(), CoreError> {
    Ok(fs::rename(from, to)?)
}

/// Removes the directory at `dir` if it is empty. One that still holds something is an
/// error and stays as it was.
pub fn remove_empty_dir(dir: &Path) -> Result<(), CoreError> {
    Ok(fs::remove_dir(dir)?)
}

/// The bytes of `path`. A missing file is an error, as any other failure to read.
pub fn read(path: &Path) -> Result<Vec<u8>, CoreError> {
    Ok(fs::read(path)?)
}

/// The contents of `path` as text. A missing file is an error, as any other failure to
/// read; see [`read_if_present`] for the read that is content with nothing there.
pub fn read_text(path: &Path) -> Result<String, CoreError> {
    Ok(fs::read_to_string(path)?)
}

/// The contents of a file that is expected to be there, as text.
///
/// Unlike [`read_text`], the two refusals a caller acts on get their own answers, named
/// after `path`: a missing file is [`CoreError::NotFound`], and bytes that are not UTF-8
/// are [`CoreError::NotText`]. Any other failure stays [`CoreError::Io`].
pub fn read_existing_text(path: &Path) -> Result<String, CoreError> {
    fs::read_to_string(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::NotFound(path.display().to_string()),
        std::io::ErrorKind::InvalidData => CoreError::NotText(path.display().to_string()),
        _ => CoreError::Io(e),
    })
}

/// Whether a regular file is at `path`, following links.
#[must_use]
pub fn is_file(path: &Path) -> bool {
    path.is_file()
}

/// Removes the file at `path`. A missing file is an error; see [`remove_if_present`] for
/// the removal that is content with nothing there.
pub fn remove(path: &Path) -> Result<(), CoreError> {
    Ok(fs::remove_file(path)?)
}

/// Removes `dir` with everything under it, if it is a directory. Anything else at `dir`,
/// or nothing, is left as it is.
pub fn remove_dir_all_if_dir(dir: &Path) -> Result<(), CoreError> {
    if dir.is_dir() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// Creates the file at `path` only if nothing is there yet, and fills it with what `render`
/// returns. `true` when it was created; `false`, with `render` never called, when the name
/// was already taken.
///
/// The name is taken first (`create_new`, `O_EXCL`) and filled after, so two writers never
/// both get the same name. A `render` that fails leaves the empty file behind.
pub fn create_new_with<F>(path: &Path, render: F) -> Result<bool, CoreError>
where
    F: FnOnce() -> Result<String, CoreError>,
{
    use std::io::Write as _;

    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(render()?.as_bytes())?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Every file under `root`, depth first in the order the directories list them. A
/// directory is walked into, not listed; a link is listed as it is, not followed.
///
/// A directory or an item that cannot be read is skipped silently, `root` included: one
/// bad corner does not hide the rest.
#[must_use]
pub fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk_into(root, &mut found);
    found
}

fn walk_into(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            walk_into(&path, found);
        } else {
            found.push(path);
        }
    }
}

/// A running number that keeps temporary file names from colliding within one process.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Writes a temporary file in the same directory, then replaces the target by rename.
///
/// Overwriting directly with `fs::write` leaves a half-written file if the process dies mid-write.
/// Scrawl rewrites a whole day on every append, so that would mean the corruption of the entire
/// day's record. A rename is atomic within one filesystem, so a reader sees either the old content
/// or the new, never anything else.
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

/// The contents of `path` as text, or `None` when there is no such file.
pub fn read_if_present(path: &Path) -> Result<Option<String>, CoreError> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Removes `path`. A file that is already gone leaves the state asked for, so it is no error.
pub fn remove_if_present(path: &Path) -> Result<(), CoreError> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// [`write_atomic`], then leaves the file readable and writable by its owner alone (0o600).
///
/// For a secret kept in a file (the Android login token): the OS keeps other apps out of the
/// app-private directory, and the mode keeps out everyone else on the device.
#[cfg(all(unix, any(target_os = "android", test)))]
pub fn write_owner_only<C: AsRef<[u8]>>(path: &Path, contents: C) -> Result<(), CoreError> {
    use std::os::unix::fs::PermissionsExt as _;

    write_atomic(path, contents)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
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

/// Moves `from` to `to`, and refuses when `to` is taken: the answer is then
/// `CoreError::Io` with `AlreadyExists`, and both files stay as they were.
///
/// Not [`rename_without_clobber`], which escapes to a spare name and always lands: this one
/// is for a name the user chose, where landing anywhere else would be a surprise. A plain
/// `fs::rename` would silently replace what is there. The name is reserved first with
/// `create_new`, and if the move then fails the reserved empty file is removed again.
pub fn rename_no_replace(from: &Path, to: &Path) -> Result<(), CoreError> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    fs::rename(from, to).map_err(|e| {
        let _ = fs::remove_file(to);
        CoreError::from(e)
    })
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

/// One item [`list_md_files`] hands out.
pub type Entry = DirEntry;

/// `e.path()` allocates a `PathBuf` that includes the directory name. Just checking
/// the extension needs only the file name, so the per-entry allocation is that much smaller.
fn is_md(entry: &DirEntry) -> bool {
    Path::new(&entry.file_name())
        .extension()
        .is_some_and(|ext| ext == "md")
}

/// The `.md` files directly under `dir`, in no particular order: a caller that needs an
/// order sorts them itself. A missing directory is empty rather than an error.
pub fn list_md_files(dir: &Path) -> Result<Vec<DirEntry>, CoreError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    Ok(fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter(is_md)
        .collect())
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
    fn lists_only_md_files() {
        let tmp = seed(&["a.md", "b.md", "c.txt", "no-extension"]);

        let mut names: Vec<_> = list_md_files(tmp.path())
            .unwrap()
            .iter()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();

        assert_eq!(names, vec!["a.md", "b.md"]);
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

    #[test]
    fn rename_no_replace_moves_to_a_free_name() {
        let tmp = seed(&["a.md"]);
        let from = tmp.path().join("a.md");
        let to = tmp.path().join("b.md");

        rename_no_replace(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(fs::read_to_string(&to).unwrap(), "x");
    }

    /// A taken name is refused, not replaced and not escaped to a spare name.
    #[test]
    fn rename_no_replace_keeps_what_is_already_there() {
        let tmp = TempDir::new().unwrap();
        let from = tmp.path().join("a.md");
        let to = tmp.path().join("b.md");
        fs::write(&from, "newcomer").unwrap();
        fs::write(&to, "the one already there").unwrap();

        let result = rename_no_replace(&from, &to);

        assert!(matches!(
            result,
            Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists
        ));
        assert_eq!(fs::read_to_string(&from).unwrap(), "newcomer");
        assert_eq!(fs::read_to_string(&to).unwrap(), "the one already there");
        assert!(!tmp.path().join("b-2.md").exists());
    }

    /// A failed move leaves no empty file under the new name, or the name would read as
    /// taken from then on.
    #[test]
    fn rename_no_replace_leaves_no_placeholder_when_the_move_fails() {
        let tmp = TempDir::new().unwrap();
        let to = tmp.path().join("b.md");

        assert!(rename_no_replace(&tmp.path().join("nope.md"), &to).is_err());

        assert!(!to.exists());
    }

    #[test]
    fn read_text_returns_the_contents() {
        let tmp = seed(&["a.md"]);

        assert_eq!(read_text(&tmp.path().join("a.md")).unwrap(), "x");
    }

    #[test]
    fn read_text_of_a_missing_file_is_an_io_error() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            read_text(&tmp.path().join("nope")),
            Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
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

    #[test]
    fn read_if_present_reads_a_file_that_is_there() {
        let tmp = seed(&["a.md"]);

        assert_eq!(
            read_if_present(&tmp.path().join("a.md"))
                .unwrap()
                .as_deref(),
            Some("x")
        );
    }

    #[test]
    fn read_if_present_answers_none_for_a_missing_file() {
        let tmp = TempDir::new().unwrap();

        assert_eq!(read_if_present(&tmp.path().join("nope")).unwrap(), None);
    }

    /// Only "not there" is an answer. Anything else that stops the read is still an error,
    /// or a token that cannot be read would look like a device that never logged in.
    #[test]
    fn read_if_present_still_fails_on_what_cannot_be_read() {
        let tmp = TempDir::new().unwrap();

        assert!(read_if_present(tmp.path()).is_err());
    }

    #[test]
    fn remove_if_present_removes_the_file() {
        let tmp = seed(&["a.md"]);
        let path = tmp.path().join("a.md");

        remove_if_present(&path).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn remove_if_present_is_content_when_nothing_is_there() {
        let tmp = TempDir::new().unwrap();

        remove_if_present(&tmp.path().join("nope")).unwrap();
    }

    #[test]
    fn remove_if_present_still_fails_on_what_cannot_be_removed() {
        let tmp = TempDir::new().unwrap();

        assert!(remove_if_present(tmp.path()).is_err());
    }

    #[test]
    fn resolve_writable_creates_the_directory_and_joins_the_name() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/glyphs");

        let path = resolve_writable(&dir, "a.png").unwrap();

        assert!(dir.is_dir());
        assert_eq!(path, fs::canonicalize(&dir).unwrap().join("a.png"));
        assert!(!path.exists(), "only the directory is made, not the file");
    }

    /// The directory is resolved before the name is joined, so a link on the way to it
    /// is already followed in the answer.
    #[cfg(unix)]
    #[test]
    fn resolve_writable_answers_with_the_directory_a_link_points_at() {
        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        std::os::unix::fs::symlink(&real, tmp.path().join("linked")).unwrap();

        let path = resolve_writable(&tmp.path().join("linked"), "a.png").unwrap();

        assert_eq!(path, fs::canonicalize(&real).unwrap().join("a.png"));
    }

    fn sorted(mut listed: Vec<Listed>) -> Vec<Listed> {
        listed.sort_by(|a, b| a.name.cmp(&b.name));
        listed
    }

    #[test]
    fn list_entries_names_every_item_with_its_size() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.png"), "12345").unwrap();
        fs::write(tmp.path().join(".hidden"), "").unwrap();

        assert_eq!(
            sorted(list_entries(tmp.path()).unwrap()),
            vec![
                Listed {
                    name: ".hidden".to_string(),
                    bytes: 0
                },
                Listed {
                    name: "a.png".to_string(),
                    bytes: 5
                },
            ]
        );
    }

    /// Choosing what counts is the caller's job, so a directory is listed like a file.
    #[test]
    fn list_entries_lists_a_directory_too() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("sub.png")).unwrap();

        let names: Vec<String> = list_entries(tmp.path())
            .unwrap()
            .into_iter()
            .map(|listed| listed.name)
            .collect();

        assert_eq!(names, vec!["sub.png"]);
    }

    #[test]
    fn list_entries_of_a_missing_directory_is_empty() {
        let tmp = TempDir::new().unwrap();

        assert!(list_entries(&tmp.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn list_entries_still_fails_on_what_is_not_a_directory() {
        let tmp = seed(&["a.md"]);

        assert!(list_entries(&tmp.path().join("a.md")).is_err());
    }

    #[test]
    fn entry_names_lists_files_and_directories() {
        let tmp = seed(&["a.md", "b.txt"]);
        fs::create_dir(tmp.path().join("sub")).unwrap();

        let mut names = entry_names(tmp.path()).unwrap();
        names.sort();

        assert_eq!(names, vec!["a.md", "b.txt", "sub"]);
    }

    #[test]
    fn entry_names_of_a_missing_directory_is_empty() {
        let tmp = TempDir::new().unwrap();

        assert!(entry_names(&tmp.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn entry_names_still_fails_on_what_is_not_a_directory() {
        let tmp = seed(&["a.md"]);

        assert!(entry_names(&tmp.path().join("a.md")).is_err());
    }

    #[test]
    fn entries_yields_the_name_of_each_item() {
        let tmp = seed(&["a.md", "b.md"]);
        fs::create_dir(tmp.path().join("sub")).unwrap();

        let mut names: Vec<OsString> = entries(tmp.path())
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        names.sort();

        assert_eq!(names, vec!["a.md", "b.md", "sub"]);
    }

    #[test]
    fn entries_of_a_missing_directory_is_an_io_error() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            entries(&tmp.path().join("nope")),
            Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn count_entries_counts_files_and_directories() {
        let tmp = seed(&["a.md", "b.md"]);
        fs::create_dir(tmp.path().join("sub")).unwrap();

        assert_eq!(count_entries(tmp.path()).unwrap(), 3);
    }

    #[test]
    fn count_entries_of_a_missing_directory_is_an_io_error() {
        let tmp = TempDir::new().unwrap();

        assert!(count_entries(&tmp.path().join("nope")).is_err());
    }

    #[test]
    fn exists_and_is_dir_tell_a_file_from_a_directory() {
        let tmp = seed(&["a.md"]);
        let file = tmp.path().join("a.md");
        let missing = tmp.path().join("nope");

        assert!(exists(&file) && !is_dir(&file));
        assert!(exists(tmp.path()) && is_dir(tmp.path()));
        assert!(!exists(&missing) && !is_dir(&missing));
    }

    #[test]
    fn is_read_only_is_false_for_a_writable_file_and_for_nothing() {
        let tmp = seed(&["a.md"]);

        assert!(!is_read_only(&tmp.path().join("a.md")));
        assert!(!is_read_only(&tmp.path().join("nope")));
    }

    #[cfg(unix)]
    #[test]
    fn is_read_only_is_true_for_a_file_no_one_may_write() {
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = seed(&["a.md"]);
        let path = tmp.path().join("a.md");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();

        assert!(is_read_only(&path));
    }

    #[test]
    fn rename_moves_a_directory_whole() {
        let tmp = TempDir::new().unwrap();
        let from = tmp.path().join("old");
        fs::create_dir(&from).unwrap();
        fs::write(from.join("a.md"), "x").unwrap();
        let to = tmp.path().join("new");

        rename(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(fs::read_to_string(to.join("a.md")).unwrap(), "x");
    }

    #[test]
    fn rename_of_a_missing_source_is_an_io_error() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            rename(&tmp.path().join("nope"), &tmp.path().join("to")),
            Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn remove_empty_dir_removes_an_empty_directory() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("empty");
        fs::create_dir(&dir).unwrap();

        remove_empty_dir(&dir).unwrap();

        assert!(!dir.exists());
    }

    #[test]
    fn remove_empty_dir_leaves_a_directory_that_holds_something() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("full");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("a.md"), "x").unwrap();

        assert!(remove_empty_dir(&dir).is_err());
        assert!(dir.join("a.md").exists());
    }

    #[test]
    fn read_returns_the_bytes() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.png");
        fs::write(&path, b"\x89PNG").unwrap();

        assert_eq!(read(&path).unwrap(), b"\x89PNG");
    }

    #[test]
    fn read_of_a_missing_file_is_an_io_error() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            read(&tmp.path().join("nope")),
            Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn remove_removes_the_file() {
        let tmp = seed(&["a.md"]);
        let path = tmp.path().join("a.md");

        remove(&path).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn remove_of_a_missing_file_is_an_io_error() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            remove(&tmp.path().join("nope")),
            Err(CoreError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound
        ));
    }

    #[test]
    fn read_existing_text_returns_the_contents() {
        let tmp = seed(&["a.md"]);

        assert_eq!(read_existing_text(&tmp.path().join("a.md")).unwrap(), "x");
    }

    #[test]
    fn read_existing_text_names_a_missing_file_not_found() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nope.md");

        assert!(matches!(
            read_existing_text(&path),
            Err(CoreError::NotFound(name)) if name == path.display().to_string()
        ));
    }

    #[test]
    fn read_existing_text_names_bytes_that_are_not_text() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.md");
        fs::write(&path, b"\xff\xfe").unwrap();

        assert!(matches!(
            read_existing_text(&path),
            Err(CoreError::NotText(name)) if name == path.display().to_string()
        ));
    }

    #[test]
    fn read_existing_text_leaves_other_failures_as_io() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            read_existing_text(tmp.path()),
            Err(CoreError::Io(_))
        ));
    }

    #[test]
    fn is_file_tells_a_file_from_a_directory_and_nothing() {
        let tmp = seed(&["a.md"]);

        assert!(is_file(&tmp.path().join("a.md")));
        assert!(!is_file(tmp.path()));
        assert!(!is_file(&tmp.path().join("nope")));
    }

    #[test]
    fn remove_dir_all_if_dir_removes_a_directory_and_what_it_holds() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("versions");
        fs::create_dir_all(dir.join("deeper")).unwrap();
        fs::write(dir.join("deeper/a.md"), "x").unwrap();

        remove_dir_all_if_dir(&dir).unwrap();

        assert!(!dir.exists());
    }

    #[test]
    fn remove_dir_all_if_dir_leaves_a_file_and_is_content_with_nothing() {
        let tmp = seed(&["a.md"]);

        remove_dir_all_if_dir(&tmp.path().join("a.md")).unwrap();
        remove_dir_all_if_dir(&tmp.path().join("nope")).unwrap();

        assert!(tmp.path().join("a.md").exists());
    }

    #[test]
    fn create_new_with_creates_and_fills_a_free_name() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.md");

        assert!(create_new_with(&path, || Ok("body".to_string())).unwrap());

        assert_eq!(fs::read_to_string(&path).unwrap(), "body");
    }

    /// A taken name is reported, not overwritten, and nothing is rendered for it.
    #[test]
    fn create_new_with_leaves_a_taken_name_alone() {
        let tmp = seed(&["a.md"]);
        let path = tmp.path().join("a.md");

        let created = create_new_with(&path, || panic!("not rendered for a taken name")).unwrap();

        assert!(!created);
        assert_eq!(fs::read_to_string(&path).unwrap(), "x");
    }

    /// The name is taken before the content is made, so a render that fails leaves the
    /// empty file behind.
    #[test]
    fn create_new_with_keeps_the_name_when_the_render_fails() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.md");

        let result = create_new_with(&path, || Err(CoreError::Parse("boom".to_string())));

        assert!(matches!(result, Err(CoreError::Parse(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn create_new_with_fails_where_the_directory_is_missing() {
        let tmp = TempDir::new().unwrap();

        assert!(matches!(
            create_new_with(&tmp.path().join("nope/a.md"), || Ok(String::new())),
            Err(CoreError::Io(_))
        ));
    }

    #[test]
    fn walk_files_lists_every_file_and_walks_into_directories() {
        let tmp = seed(&["a.md"]);
        fs::create_dir_all(tmp.path().join("sub/deeper")).unwrap();
        fs::write(tmp.path().join("sub/b.md"), "x").unwrap();
        fs::write(tmp.path().join("sub/deeper/c.txt"), "x").unwrap();
        fs::create_dir(tmp.path().join("empty")).unwrap();

        let mut found: Vec<PathBuf> = walk_files(tmp.path())
            .into_iter()
            .map(|p| p.strip_prefix(tmp.path()).unwrap().to_path_buf())
            .collect();
        found.sort();

        assert_eq!(
            found,
            vec![
                PathBuf::from("a.md"),
                PathBuf::from("sub/b.md"),
                PathBuf::from("sub/deeper/c.txt"),
            ]
        );
    }

    #[test]
    fn walk_files_of_a_missing_root_is_empty() {
        let tmp = TempDir::new().unwrap();

        assert!(walk_files(&tmp.path().join("nope")).is_empty());
    }

    /// A link to a directory is an item to the walk, not a way into the directory.
    #[cfg(unix)]
    #[test]
    fn walk_files_lists_a_link_without_following_it() {
        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir(&real).unwrap();
        fs::write(real.join("a.md"), "x").unwrap();
        let root = tmp.path().join("root");
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(&real, root.join("linked")).unwrap();

        assert_eq!(walk_files(&root), vec![root.join("linked")]);
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;

        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn write_owner_only_leaves_the_file_to_its_owner() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("auth-token");

        write_owner_only(&path, "secret").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "secret");
        assert_eq!(mode_of(&path), 0o600);
    }

    /// The rename puts a fresh file in place, so a file that was open to others before
    /// does not pass its mode on.
    #[cfg(unix)]
    #[test]
    fn write_owner_only_closes_a_file_that_was_open_to_others() {
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("auth-token");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_owner_only(&path, "new").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(mode_of(&path), 0o600);
    }
}
