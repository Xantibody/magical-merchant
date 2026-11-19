//! Note, the Markdown workspace, and the file every Codex shares with it.
//!
//! One file per record under `data/notes/` (a Note) or `data/codex/` (a Codex), named
//! after its creation time, which is its ID. The directory is the kind, never a
//! frontmatter key.

pub(crate) mod conflicts;
mod create;
mod delete;
mod details;
mod edit;
pub(crate) mod file;
mod history;
pub(crate) mod id;
pub(crate) mod kind;
pub(crate) mod list;
mod open;
mod repair;
mod revision;
mod row;

pub use conflicts::{relocate_conflict_copies, relocate_duplicate_ids};
pub use create::{create_draft, create_note_at};
pub use delete::delete_note;
pub use details::{update_note_meta, update_note_origin, update_note_view};
pub use edit::update_note;
pub use file::{NoteFrontmatter, Provenance};
pub use history::{Snapshot, list_note_history, read_note_history, restore_note, snapshot_note};
pub use id::NoteFilename;
pub use kind::NoteKind;
pub use list::list_notes;
pub use open::{locate_note, read_note_by_filename, read_note_meta};
pub use repair::repair_notes;
pub use revision::Revision;
pub use row::Summary as NoteSummary;
