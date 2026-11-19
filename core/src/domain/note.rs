//! Note, the Markdown workspace, and the file every Codex shares with it.
//!
//! One file per record under `data/notes/` (a Note) or `data/codex/` (a Codex), named
//! after its creation time, which is its ID. The directory is the kind, never a
//! frontmatter key.

mod create;
pub(crate) mod file;
pub(crate) mod id;
pub(crate) mod kind;
pub(crate) mod list;
mod open;
mod revision;
mod row;

pub use create::{create_draft_codex, create_draft_note, create_note_at};
pub use file::{NoteFrontmatter, Provenance};
pub use id::NoteFilename;
pub use kind::NoteKind;
pub use list::list_notes;
pub use open::{locate_note, read_note, read_note_by_filename, read_note_meta};
pub use revision::Revision;
pub use row::Summary as NoteSummary;
