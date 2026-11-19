//! Codex, a Note that grows and keeps the versions a person commits.
//!
//! The draft is a note file under `data/codex/`; its versions sit beside it under
//! `data/codex/<stem>/`, one Markdown file each, and ride on sync.

mod promote;
pub(crate) mod version;

pub use promote::promote_note_to_codex;
pub use version::{
    BEFORE_RESTORE, DRAFT, Version, VersionStatus, commit_note_version, delete_note_version,
    diff_note_versions, list_note_versions, note_version_status, read_note_version,
    restore_note_version,
};
