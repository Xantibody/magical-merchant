//! Pins every name the crate root exports.
//!
//! The core tree moves module by module (plans 24-33) while `lib.rs` keeps re-exporting
//! the same names. The app and the CLI only show a dropped name they happen to use; this
//! touches each one once, the unused ones too. A step that drops or renames a name on
//! purpose fixes its line here in the same commit.
//!
//! A function is touched as a function pointer with one `_` per argument, so its arity is
//! pinned with its name; a type is touched as `Option<T>`.

use magical_merchant_core::{
    BEFORE_RESTORE, CoreError, CreatedNote, DRAFT, DeviceContext, GLYPH_MAX_BYTES, GlyphData,
    GlyphFormat, GlyphName, GlyphSummary, HitKind, NoteFilename, NoteKind, NoteMeta, NoteSummary,
    OpenedNote, Provenance, Revision, ScrawlDay, ScrawlDays, ScrawlDirMigration, ScrawlEntry,
    SearchFilter, SearchHit, Snapshot, Source, SyncError, TagUsage, TemplateDetail,
    TemplateSummary, TemplateToday, VarLocale, Version, VersionStatus, browse_all,
    commit_note_version, count_tags, create_draft, create_note_at, create_note_from_template,
    delete_glyph, delete_note, delete_note_version, delete_scrawl_entry, delete_template, describe,
    diff_note_versions, discard_template_draft, find_backlinks, frontmatter, list_glyphs,
    list_note_history, list_note_versions, list_notes, list_scrawl_dates, list_template_drafts,
    list_templates, locate_note, migrate_scrawl_dir, note_version_status, open_note,
    parse_scrawl_entry, promote_note_to_codex, read_glyph, read_note_by_filename,
    read_note_history, read_note_meta, read_note_version, read_scrawl, read_scrawl_days,
    read_template, read_template_draft, recent_records, relocate_conflict_copies,
    relocate_duplicate_ids, rename_template, repair_notes, restore_note, restore_note_version,
    save_glyph, save_scrawl_entry, save_template, save_template_draft, search_all, search_records,
    snapshot_note, templates_today, update_note, update_note_meta, update_note_origin,
    update_note_view,
};

#[test]
fn the_crate_root_keeps_its_types_and_constants() {
    let _: Option<CoreError> = None;
    let _: Option<SyncError> = None;

    let _: Option<GlyphData> = None;
    let _: Option<GlyphSummary> = None;
    let _: Option<GlyphFormat> = None;
    let _: Option<GlyphName> = None;
    let _: usize = GLYPH_MAX_BYTES;

    let _: Option<NoteFilename> = None;
    let _: Option<NoteKind> = None;
    let _: Option<NoteMeta> = None;
    let _: Option<NoteSummary> = None;
    let _: Option<OpenedNote> = None;
    let _: Option<Provenance<'_>> = None;
    let _: Option<Revision> = None;
    let _: Option<Snapshot> = None;
    let _: Option<Version> = None;
    let _: Option<VersionStatus> = None;
    let _: &str = DRAFT;
    let _: &str = BEFORE_RESTORE;

    let _: Option<ScrawlDay> = None;
    let _: Option<ScrawlDays> = None;
    let _: Option<ScrawlDirMigration> = None;
    let _: Option<ScrawlEntry> = None;

    let _: Option<HitKind> = None;
    let _: Option<SearchFilter> = None;
    let _: Option<SearchHit> = None;
    let _: Option<TagUsage> = None;

    let _: Option<CreatedNote> = None;
    let _: Option<TemplateDetail> = None;
    let _: Option<TemplateSummary> = None;
    let _: Option<TemplateToday> = None;
    let _: Option<VarLocale> = None;

    let _: Option<DeviceContext> = None;
    let _: Option<Source> = None;
}

#[test]
fn the_crate_root_keeps_its_functions() {
    let _: fn(_) -> _ = describe;
    let _: fn(_) -> _ = list_glyphs;
    let _: fn(_, _) -> _ = read_glyph;
    let _: fn(_, _, _, _) -> _ = save_glyph;
    let _: fn(_, _) -> _ = delete_glyph;
    let _: fn(_, _, _, _, _, _) -> _ = create_draft;
    let _: fn(_, _, _, _, _, _) -> _ = create_note_at;
    let _: fn(_, _) -> _ = promote_note_to_codex;
    let _: fn(_) -> _ = list_notes;
    let _: fn(_, _) -> _ = locate_note;
    let _: fn(_, _) -> _ = open_note;
    let _: fn(_, _) -> _ = read_note_by_filename;
    let _: fn(_, _) -> _ = read_note_meta;
    let _: fn(_, _, _, _) -> _ = update_note;
    let _: fn(_, _, _, _) -> _ = update_note_meta;
    let _: fn(_, _, _) -> _ = update_note_view;
    let _: fn(_, _, _) -> _ = update_note_origin;
    let _: fn(_, _) -> _ = delete_note;
    let _: fn(_) -> _ = repair_notes;
    let _: fn(_) -> _ = relocate_conflict_copies;
    let _: fn(_) -> _ = relocate_duplicate_ids;
    let _: fn(_, _) -> _ = snapshot_note;
    let _: fn(_, _) -> _ = list_note_history;
    let _: fn(_, _, _) -> _ = read_note_history;
    let _: fn(_, _, _, _) -> _ = restore_note;
    let _: fn(_, _, _) -> _ = commit_note_version;
    let _: fn(_, _) -> _ = list_note_versions;
    let _: fn(_, _, _) -> _ = read_note_version;
    let _: fn(_, _, _, _) -> _ = diff_note_versions;
    let _: fn(_, _, _, _, _) -> _ = restore_note_version;
    let _: fn(_, _, _) -> _ = delete_note_version;
    let _: fn(_, _) -> _ = note_version_status;
    let _: fn(_) -> _ = migrate_scrawl_dir;
    let _: fn(_, _, _, _) -> _ = save_scrawl_entry;
    let _: fn(_) -> _ = list_scrawl_dates;
    let _: fn(_, _) -> _ = read_scrawl;
    let _: fn(_, _, _) -> _ = read_scrawl_days;
    let _: fn(_, _, _, _) -> _ = delete_scrawl_entry;
    let _: fn(_) -> _ = parse_scrawl_entry;
    let _: fn(_, _, _) -> _ = search_all;
    let _: fn(_, _, _, _) -> _ = search_records;
    let _: fn(_) -> _ = browse_all;
    let _: fn(_, _) -> _ = recent_records;
    let _: fn(_, _) -> _ = find_backlinks;
    let _: fn(_) -> _ = count_tags;
    let _: fn(_) -> _ = list_templates;
    let _: fn(_, _) -> _ = read_template;
    let _: fn(_, _, _, _) -> _ = save_template;
    let _: fn(_, _) -> _ = delete_template;
    let _: fn(_, _, _) -> _ = rename_template;
    let _: fn(_, _, _) -> _ = save_template_draft;
    let _: fn(_, _) -> _ = read_template_draft;
    let _: fn(_, _) -> _ = discard_template_draft;
    let _: fn(_) -> _ = list_template_drafts;
    let _: fn(_, _, _, _, _) -> _ = create_note_from_template;
    let _: fn(_, _) -> _ = templates_today;
    let _: fn(_) -> _ = frontmatter::strip;
    let _: fn(_) -> _ = frontmatter::is_plain_markdown;
}
