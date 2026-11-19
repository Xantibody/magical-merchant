//! Scrawl, the quick capture journal.
//!
//! One file per day under `data/scrawl/YYYY-MM-DD.md`, one line per record, newest
//! appended last. The app, the CLI and the widget write it; MCP only reads it.

mod capture;
pub(crate) mod day;
mod delete;
pub mod entry;
pub(crate) mod journal;
mod migrate;

pub use capture::save_scrawl_entry;
pub use delete::delete_scrawl_entry;
pub use journal::{ScrawlDay, ScrawlDays, list_scrawl_dates, read_scrawl, read_scrawl_days};
pub use migrate::{ScrawlDirMigration, migrate_scrawl_dir};
