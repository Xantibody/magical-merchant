use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset, Local};

use crate::error::CoreError;
use crate::utils::device::Context;
use crate::utils::frontmatter::{self, NoteFrontmatter, Provenance};
use crate::utils::fs::{ensure_dir, list_md_files, write_atomic};
use crate::utils::markdown::format_note_markdown;
use crate::utils::validated::NoteFilename;

use super::kind::NoteKind;
use super::revision::Revision;
use super::summary::Summary as NoteSummary;

pub(crate) struct Notes {
    base_dir: PathBuf,
}

impl Notes {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Create one note right now. The time is just passed to `create_at`.
    pub(crate) fn create(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        self.create_at(Local::now().fixed_offset(), body, tags, context, provenance)
    }

    /// Create one Codex right now. Only the directory differs; the name and the
    /// frontmatter are the same as a Note's.
    pub(crate) fn create_codex(
        &self,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        self.create_kind_at(
            NoteKind::Codex,
            Local::now().fixed_offset(),
            body,
            tags,
            context,
            provenance,
        )
    }

    /// Create one note with the given creation time. Returns the path of the file written.
    ///
    /// The filename is the time down to the second, and that is the note's ID
    /// (the format is immutable). When two notes are created in the same second,
    /// advance one second at a time until a free second is found. This does not
    /// rename anything; it only picks a name nobody uses yet. The frontmatter
    /// `time` is aligned to the advanced time too. If the name (list order) and
    /// `time` (display) drift apart, order and date disagree within one list.
    /// The same holds for a time in the past: imported records sort at their
    /// original time, and none of the same-second ones is lost.
    ///
    /// Reservation is left to `create_new`. Checking with `exists()` and then
    /// writing lets another thread or process take the same name in between.
    /// Creation does not go through `write_atomic` (tmp, then rename): rename
    /// silently replaces an existing file, which defeats collision avoidance.
    /// A crash mid-write here loses only the half-written new note; existing
    /// records are not damaged.
    pub(crate) fn create_at(
        &self,
        time: DateTime<FixedOffset>,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        self.create_kind_at(NoteKind::Note, time, body, tags, context, provenance)
    }

    /// IDs are one namespace across both kinds. If the other directory holds
    /// the same name, that second counts as taken too, and we advance one second.
    /// This side checks with `exists()`, so there is a gap, but only when two
    /// directories, two processes and the same second all coincide; the actual
    /// damage is picked up by `relocate_duplicate_ids`.
    fn create_kind_at(
        &self,
        kind: NoteKind,
        time: DateTime<FixedOffset>,
        body: &str,
        tags: &[String],
        context: &Context,
        provenance: Provenance<'_>,
    ) -> Result<PathBuf, CoreError> {
        let mut time = time;
        let mut file_path = kind.file_path(&self.base_dir, time);
        ensure_dir(&file_path)?;

        loop {
            if kind.other().file_path(&self.base_dir, time).exists() {
                time += chrono::Duration::seconds(1);
                file_path = kind.file_path(&self.base_dir, time);
                continue;
            }
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file_path)
            {
                Ok(mut file) => {
                    let markdown = format_note_markdown(body, tags, time, context, provenance)?;
                    file.write_all(markdown.as_bytes())?;
                    return Ok(file_path);
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    time += chrono::Duration::seconds(1);
                    file_path = kind.file_path(&self.base_dir, time);
                }
                Err(e) => return Err(e.into()),
            }
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let mut summaries = Vec::new();
        self.scan(|summary, _| summaries.push(summary))?;
        Ok(summaries)
    }

    /// Read every note once and hand `visit` the summary and the body with the
    /// frontmatter stripped. If a path that looks at every body (search, backlinks)
    /// re-reads each note after `list`, that is two open(2) calls per note. On macOS
    /// open takes about 60% of the whole path, so the content read to build the
    /// summary is passed on as is.
    ///
    /// The body is lent one note at a time; all bodies are never held at once.
    /// Returning summary and body pairs in a Vec makes heap usage the sum of all
    /// bodies in a large store.
    ///
    /// A note that cannot be read yields an empty summary and an empty body, as in
    /// `list`.
    ///
    /// Both directories are merged into one list, sorted by filename (creation
    /// time), newest first. Filtering per surface is done by the caller via `kind`.
    pub(crate) fn scan(&self, mut visit: impl FnMut(NoteSummary, &str)) -> Result<(), CoreError> {
        let mut entries: Vec<(NoteKind, fs::DirEntry)> = Vec::new();
        for kind in [NoteKind::Note, NoteKind::Codex] {
            for entry in list_md_files(&kind.dir(&self.base_dir))? {
                entries.push((kind, entry));
            }
        }
        entries.sort_by_cached_key(|(_, e)| std::cmp::Reverse(e.file_name()));

        for (kind, entry) in entries {
            let path = entry.path();
            let filename = entry.file_name().to_string_lossy().to_string();
            let content = fs::read_to_string(&path).unwrap_or_default();
            let body = frontmatter::strip(&content);
            // Versions live next to the note, under the name minus `.md`. Version bodies
            // are not read
            let versions = path.with_extension("");
            let mut summary = NoteSummary::from_file(kind, path, filename, &content);
            if kind == NoteKind::Codex {
                let (count, dirty) = super::version::list_status(&versions, body)?;
                summary.version_count = Some(count);
                summary.dirty = Some(dirty);
            }
            visit(summary, body);
        }
        Ok(())
    }

    /// Find a note by ID alone. The directory it is found in is its kind. Codex is
    /// checked first so that, when sync brings back the old `notes/` copy right
    /// after a promotion, the Codex one is opened: the side with committed versions
    /// is the real one, and the returned copy is cleaned up by
    /// `relocate_duplicate_ids`.
    pub(crate) fn locate(&self, filename: &NoteFilename) -> Result<(NoteKind, PathBuf), CoreError> {
        for kind in [NoteKind::Codex, NoteKind::Note] {
            match crate::utils::fs::resolve_existing(&kind.dir(&self.base_dir), filename.as_str()) {
                Ok(path) => return Ok((kind, path)),
                Err(CoreError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Err(CoreError::NotFound(
            NoteKind::Note
                .dir(&self.base_dir)
                .join(filename.as_str())
                .to_string_lossy()
                .to_string(),
        ))
    }

    fn existing_note_path(&self, filename: &NoteFilename) -> Result<PathBuf, CoreError> {
        Ok(self.locate(filename)?.1)
    }

    /// Move a note into the Codex directory. Neither the ID (filename) nor the
    /// content changes. It is a rename within one filesystem, so it is atomic and
    /// a concurrent reader never sees a half-way state. A note that is already a
    /// Codex is left alone.
    pub(crate) fn promote_to_codex(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        let (kind, path) = self.locate(filename)?;
        if kind == NoteKind::Codex {
            return Ok(());
        }
        let target = NoteKind::Codex.dir(&self.base_dir).join(filename.as_str());
        ensure_dir(&target)?;
        fs::rename(path, target)?;
        Ok(())
    }

    pub(crate) fn read(&self, filename: &NoteFilename) -> Result<String, CoreError> {
        let content = fs::read_to_string(self.existing_note_path(filename)?)?;
        Ok(frontmatter::strip(&content).to_string())
    }

    /// Rewrite the body only. The frontmatter is a record from creation, so it is left alone.
    ///
    /// - time: creation time. The list is ordered by filename (creation time), so
    ///   moving it on edit makes the date group and the order disagree
    /// - tags: already migrated to `#` notation in the body, but overwriting the
    ///   ones set from the tag field back then with an empty list strips old
    ///   notes of their classification
    /// - context: a record of which device wrote it. Not overwritten with the editing device
    ///
    /// A file whose frontmatter cannot be parsed is refused ([`CoreError::Parse`]).
    /// Rebuilding it with the current time and device would drop `time` / `tags` /
    /// `origin` / `view` / `template` / `source` on a one-character edit, and disagree
    /// with the filename (= creation time). Refusing beats writing a fabricated
    /// record: the same call as `edit_frontmatter`. Only a file with no delimiter
    /// at all is written as before, since there is no record to lose. A file whose
    /// opening delimiter is never closed is not "no record" but "broken": the lines
    /// under `---` were written as a record, and overwriting them with the body loses them.
    ///
    /// A file that cannot be read as text is refused too ([`CoreError::NotText`]).
    /// Its content could not be read, so neither the `expected` check nor the
    /// frontmatter carry-over is possible, and writing would overwrite the
    /// unreadable bytes with the body.
    ///
    /// A missing file is not written ([`CoreError::NotFound`]). This path replaces
    /// the body of an existing note; creation happens only in the `create` family.
    /// If it could write, a deleted note or one moved to Codex would come back to
    /// life in its old directory through a late save from a screen still open.
    ///
    /// The only thing added here is `updated`. This path is the only one that
    /// rewrites the body; replacing metadata or the view mode is not a "rewrite".
    ///
    /// `expected` is the fingerprint of the body as read. If it differs from the
    /// current body, someone wrote first; writing over it silently loses their edit.
    pub(crate) fn update(
        path: &Path,
        body: &str,
        context: &Context,
        expected: Option<&Revision>,
    ) -> Result<Revision, CoreError> {
        let existing = fs::read_to_string(path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => CoreError::NotFound(path.display().to_string()),
            // A file that cannot be read as text is refused for the same reason on
            // every rewrite or re-read. Folded into `Io`, the caller cannot tell it
            // from a transient fault, and a save that was given up on is treated as
            // one that "will go through later"
            io::ErrorKind::InvalidData => CoreError::NotText(path.display().to_string()),
            _ => CoreError::Io(e),
        })?;
        if let Some(expected) = expected {
            let current = Revision::of(frontmatter::strip(&existing));
            if current != *expected {
                let name = path.file_name().map_or_else(
                    || path.display().to_string(),
                    |n| n.to_string_lossy().to_string(),
                );
                return Err(CoreError::Stale(name));
            }
        }
        let now = Local::now();
        let fm = match frontmatter::parse::<NoteFrontmatter>(&existing) {
            Ok((fm, _)) => NoteFrontmatter {
                updated: Some(now.into()),
                ..fm
            },
            // A file with no record (plain Markdown dropped in from outside) may be
            // written. Only a file with no delimiter at all gets here: an unclosed
            // delimiter is a record that is broken, and rebuilding it loses the lines below
            Err(_) if frontmatter::is_plain_markdown(&existing) => NoteFrontmatter {
                context: Some(context.clone()),
                ..NoteFrontmatter::new(now.into())
            },
            Err(e) => return Err(e),
        };

        let markdown = frontmatter::render(&fm, body)?;
        write_atomic(path, markdown)?;
        Ok(Revision::of(body))
    }

    pub(crate) fn read_meta(&self, filename: &NoteFilename) -> Result<NoteFrontmatter, CoreError> {
        let content = fs::read_to_string(self.existing_note_path(filename)?)?;
        let (fm, _body) = frontmatter::parse::<NoteFrontmatter>(&content)?;
        Ok(fm)
    }

    /// Replace part of the frontmatter and write it back. The body is not touched.
    ///
    /// Unlike `update`, a file whose frontmatter cannot be parsed is not rebuilt.
    /// A body save must not be allowed to fail, but a metadata edit is better
    /// refused than written as a fabricated record.
    fn edit_frontmatter<F>(&self, filename: &NoteFilename, edit: F) -> Result<(), CoreError>
    where
        F: FnOnce(NoteFrontmatter) -> NoteFrontmatter,
    {
        let path = self.existing_note_path(filename)?;
        let content = fs::read_to_string(&path)?;
        let (existing, body) = frontmatter::parse::<NoteFrontmatter>(&content)?;
        write_atomic(&path, frontmatter::render(&edit(existing), body)?)?;
        Ok(())
    }

    /// Replace only time and tags. context is not touched.
    pub(crate) fn update_meta(
        &self,
        filename: &NoteFilename,
        time: DateTime<FixedOffset>,
        tags: &[String],
    ) -> Result<(), CoreError> {
        self.edit_frontmatter(filename, |existing| NoteFrontmatter {
            time,
            tags: tags.to_vec(),
            ..existing
        })
    }

    /// Replace only the view mode.
    pub(crate) fn update_view(
        &self,
        filename: &NoteFilename,
        view: Option<&str>,
    ) -> Result<(), CoreError> {
        self.edit_frontmatter(filename, |existing| NoteFrontmatter {
            view: view.map(str::to_string),
            ..existing
        })
    }

    /// Replace only the link to the entry it was promoted from.
    pub(crate) fn update_origin(
        &self,
        filename: &NoteFilename,
        origin: Option<&str>,
    ) -> Result<(), CoreError> {
        self.edit_frontmatter(filename, |existing| NoteFrontmatter {
            origin: origin.map(str::to_string),
            ..existing
        })
    }

    /// A Codex is deleted together with its versions directory (`codex/<stem>/`).
    /// Deleting only the note leaves versions that belong to nobody, and sync
    /// keeps distributing them.
    pub(crate) fn delete(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        let (kind, path) = self.locate(filename)?;
        fs::remove_file(path)?;
        if kind == NoteKind::Codex {
            let versions = super::version::versions_dir(&self.base_dir, filename);
            if versions.is_dir() {
                fs::remove_dir_all(versions)?;
            }
        }
        Ok(())
    }
}
