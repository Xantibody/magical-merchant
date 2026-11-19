use std::fs;
use std::path::PathBuf;

use crate::domain::note::{NoteFilename, NoteKind, locate_note};
use crate::error::CoreError;
use crate::services::files::ensure_dir;

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
}
