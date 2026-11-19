// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod domain;
pub mod services;
pub mod utils;

// The crate root's names, layer by layer (utils, then domain) and thing by thing. The
// app, the CLI and the benches use these; `tests/public_api.rs` pins every one.

pub use utils::error::{CoreError, SyncError, describe};
pub use utils::frontmatter;

pub use domain::backlinks::find_backlinks;
pub use domain::browse::{browse_all, recent_records};
pub use domain::codex::{
    BEFORE_RESTORE, DRAFT, Version, VersionStatus, commit_note_version, delete_note_version,
    diff_note_versions, list_note_versions, note_version_status, promote_note_to_codex,
    read_note_version, restore_note_version,
};
pub use domain::device::Context as DeviceContext;
/// The fixed vocabulary of entry points that wrote a record. Every creation entry takes one.
pub use domain::device::Source;
pub use domain::glyphs::{
    GLYPH_MAX_BYTES, GlyphData, GlyphFormat, GlyphName, GlyphSummary, delete_glyph, list_glyphs,
    read_glyph, save_glyph,
};
/// The metadata of one note. Its content is the frontmatter itself.
pub use domain::note::NoteFrontmatter as NoteMeta;
/// The provenance that can be written only when a note is created. Every creation entry takes one.
pub use domain::note::Provenance;
pub use domain::note::{
    NoteFilename, NoteKind, NoteSummary, OpenedNote, RestoredNote, Revision, Snapshot,
    create_draft, create_note_at, delete_note, list_note_history, list_notes, locate_note,
    open_note, read_note_by_filename, read_note_history, read_note_meta, relocate_conflict_copies,
    relocate_duplicate_ids, repair_notes, restore_note, snapshot_note, update_note,
    update_note_meta, update_note_origin, update_note_view,
};
pub use domain::scrawl::entry::{ScrawlEntry, parse_scrawl_entry};
pub use domain::scrawl::{
    DatedEntry, EntriesBetween, ScrawlDay, ScrawlDays, ScrawlDirMigration, delete_scrawl_entry,
    entries_between, list_scrawl_dates, migrate_scrawl_dir, read_scrawl, read_scrawl_days,
    save_scrawl_entry,
};
pub use domain::search::{HitKind, SearchFilter, SearchHit, search_all, search_records};
pub use domain::tags::{TagUsage, count_tags};
pub use domain::templates::{
    CreatedNote, TemplateDetail, TemplateSummary, TemplateToday, VarLocale,
    create_note_from_template, delete_template, discard_template_draft, list_template_drafts,
    list_templates, read_template, read_template_draft, rename_template, save_template,
    save_template_draft, templates_today,
};
