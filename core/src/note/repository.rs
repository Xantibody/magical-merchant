use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::domain::note::file;
use crate::domain::note::{NoteFilename, NoteFrontmatter, NoteKind, Revision, locate_note};
use crate::error::CoreError;
use crate::services::files::{ensure_dir, write_atomic};
use crate::utils::clock::Stamp;
use crate::utils::device::Context;

pub(crate) struct Notes {
    base_dir: PathBuf,
}

impl Notes {
    pub(crate) const fn new(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Move a note into the Codex directory. Neither the ID (filename) nor the
    /// content changes. It is a rename within one filesystem, so it is atomic and
    /// a concurrent reader never sees a half-way state. A note that is already a
    /// Codex is left alone.
    pub(crate) fn promote_to_codex(&self, filename: &NoteFilename) -> Result<(), CoreError> {
        let (kind, path) = locate_note(&self.base_dir, filename)?;
        if kind == NoteKind::Codex {
            return Ok(());
        }
        let target = NoteKind::Codex.dir(&self.base_dir).join(filename.as_str());
        ensure_dir(&target)?;
        fs::rename(path, target)?;
        Ok(())
    }

    /// Rewrite the body only: read the file, let [`file::rewrite`] decide the new text,
    /// and write it back. Returns the revision of the written body.
    ///
    /// A file that cannot be read as text is refused ([`CoreError::NotText`]).
    /// Its content could not be read, so neither the `expected` check nor the
    /// frontmatter carry-over is possible, and writing would overwrite the
    /// unreadable bytes with the body.
    ///
    /// A missing file is not written ([`CoreError::NotFound`]). This path replaces
    /// the body of an existing note; creation happens only in the `create` family.
    /// If it could write, a deleted note or one moved to Codex would come back to
    /// life in its old directory through a late save from a screen still open.
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
        let name = path.file_name().map_or_else(
            || path.display().to_string(),
            |n| n.to_string_lossy().to_string(),
        );
        let markdown = file::rewrite(
            &existing,
            body,
            context,
            expected,
            Stamp::now_local(),
            &name,
        )?;
        write_atomic(path, markdown)?;
        Ok(Revision::of(body))
    }

    /// Replace part of the frontmatter ([`file::edit_record`]) and write it back.
    fn edit_frontmatter<F>(&self, filename: &NoteFilename, edit: F) -> Result<(), CoreError>
    where
        F: FnOnce(NoteFrontmatter) -> NoteFrontmatter,
    {
        let (_, path) = locate_note(&self.base_dir, filename)?;
        let content = fs::read_to_string(&path)?;
        write_atomic(&path, file::edit_record(&content, edit)?)?;
        Ok(())
    }

    /// Replace only time and tags. context is not touched.
    pub(crate) fn update_meta(
        &self,
        filename: &NoteFilename,
        time: Stamp,
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
        let (kind, path) = locate_note(&self.base_dir, filename)?;
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
