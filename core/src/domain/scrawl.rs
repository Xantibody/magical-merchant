//! Scrawl, the quick capture journal.
//!
//! One file per day under `data/scrawl/YYYY-MM-DD.md`, one line per record, newest
//! appended last. The app, the CLI and the widget write it; MCP only reads it.

pub(crate) mod day;
pub mod entry;
