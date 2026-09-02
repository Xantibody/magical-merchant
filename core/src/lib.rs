// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod note;
pub mod sync;
mod template;
mod timeline;
pub mod utils;

mod error;
pub mod search;

pub use error::CoreError;
pub use note::error::NoteError;
pub use note::{
    NoteSummary, Snapshot, create_draft_note, create_note_from_entry, delete_note,
    list_note_history, list_notes, read_note, read_note_by_filename, read_note_history,
    read_note_meta, repair_notes, restore_note, snapshot_note, update_note, update_note_meta,
    update_note_origin, update_note_view,
};
pub use search::{HitKind, SearchHit, find_backlinks, search_all};
pub use template::{
    CreatedNote, TemplateDetail, TemplateSummary, VarLocale, create_note_from_template,
    delete_template, list_templates, read_template, save_template,
};
pub use timeline::error::TimelineError;
pub use timeline::{
    delete_timeline_entry, list_timeline_dates, read_timeline, save_timeline_entry,
    update_timeline_entry,
};
pub use utils::device::Context as DeviceContext;
pub use utils::frontmatter;
/// 1 件ぶんのノートメタデータ。中身は frontmatter そのもの。
pub use utils::frontmatter::NoteFrontmatter as NoteMeta;
pub use utils::markdown::{TimelineEntry, parse_timeline_entry};
pub use utils::validated::NoteFilename;
