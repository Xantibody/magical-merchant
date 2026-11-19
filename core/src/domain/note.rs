//! Note, the Markdown workspace, and the file every Codex shares with it.
//!
//! One file per record under `data/notes/` (a Note) or `data/codex/` (a Codex), named
//! after its creation time, which is its ID. The directory is the kind, never a
//! frontmatter key.

pub(crate) mod id;
pub(crate) mod kind;
mod revision;
mod row;

pub use id::NoteFilename;
pub use kind::NoteKind;
pub use revision::Revision;
pub use row::Summary as NoteSummary;
