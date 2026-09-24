// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod glyph;
mod note;
mod scrawl;
pub mod sync;
mod template;
pub mod utils;

mod error;
pub mod search;

pub use error::CoreError;
pub use glyph::{
    GLYPH_MAX_BYTES, GlyphData, GlyphSummary, delete_glyph, list_glyphs, read_glyph, save_glyph,
};
pub use note::error::NoteError;
pub use note::{
    BEFORE_RESTORE, DRAFT, NoteKind, NoteSummary, Revision, Snapshot, Version, VersionStatus,
    commit_note_version, create_draft_codex, create_draft_note, create_note_at, delete_note,
    delete_note_version, diff_note_versions, list_note_history, list_note_versions, list_notes,
    locate_note, note_version_status, promote_note_to_codex, read_note, read_note_by_filename,
    read_note_history, read_note_meta, read_note_version, relocate_conflict_copies,
    relocate_duplicate_ids, repair_notes, restore_note, restore_note_version, snapshot_note,
    update_note, update_note_meta, update_note_origin, update_note_view,
};
pub use scrawl::error::ScrawlError;
pub use scrawl::migrate::{ScrawlDirMigration, migrate_scrawl_dir};
pub use scrawl::{
    delete_scrawl_entry, list_scrawl_dates, read_scrawl, save_scrawl_entry, update_scrawl_entry,
};
pub use search::{HitKind, SearchHit, browse_all, find_backlinks, search_all};
pub use template::{
    CreatedNote, TemplateDetail, TemplateSummary, VarLocale, create_note_from_template,
    delete_template, discard_template_draft, list_template_drafts, list_templates, read_template,
    read_template_draft, rename_template, save_template, save_template_draft,
};
pub use utils::device::Context as DeviceContext;
/// The fixed vocabulary of entry points that wrote a record. Every creation entry takes one.
pub use utils::device::Source;
pub use utils::frontmatter;
/// The metadata of one note. Its content is the frontmatter itself.
pub use utils::frontmatter::NoteFrontmatter as NoteMeta;
/// The provenance that can be written only when a note is created. Every creation entry takes one.
pub use utils::frontmatter::Provenance;
pub use utils::markdown::{ScrawlEntry, parse_scrawl_entry};
pub use utils::validated::{GlyphFormat, GlyphName, NoteFilename};
