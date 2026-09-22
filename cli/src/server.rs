use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::NaiveDate;
use magical_merchant_core::utils::frontmatter;
use magical_merchant_core::utils::paths::place_cache_path;
use magical_merchant_core::utils::place::{PlaceCache, place_key};
use magical_merchant_core::{
    GlyphFormat, GlyphName, NoteFilename, Provenance, Revision, Source, parse_scrawl_entry,
};
use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, schemars, tool, tool_router};
use serde::Deserialize;

use crate::notes;
use crate::output::{
    ContextInfo, CreatedNoteOutput, EntryInfo, GlyphListOutput, HistoryOutput,
    HistoryVersionOutput, NoteListOutput, NoteOutput, PlaceInfo, PlacesOutput, SavedGlyphOutput,
    ScrawlDatesOutput, ScrawlOutput, SearchOutput, TagInfo, TagsOutput, TemplateListOutput,
    TemplateOutput, UpdatedNoteOutput,
};

/// Cap on how many entries one range read returns.
///
/// A journal piles up over years, so an unbounded read lets a single call use up the
/// model's context.
const DEFAULT_LIMIT: usize = 500;

/// The opening of the instructions. Only this part differs between the two launches.
///
/// A writable launch that calls itself "Read-only" makes the client not write even though
/// the tools are listed: the instructions are read before the tool list, and that is where
/// it is decided.
const READ_ONLY_OPENING: &str = "Read-only access to";
const WRITABLE_OPENING: &str = "Read and write access to";

const INSTRUCTIONS_BODY: &str = " a Magical Merchant journal: \
a Scrawl of timestamped entries (one file per day) and Notes (Markdown \
files). Every record carries the device state at the moment it was written: \
local time, GPS coordinates when available, battery, network, and which \
device wrote it. Use `read_scrawl_range` to pull entries for a period, \
`list_places` to see where records were written, and `search` to find text. \
Scrawl times are the device's local wall-clock time without a UTC offset; \
note times are RFC 3339 with the offset. Bodies may contain `:name:` \
shortcodes that the app renders as user-registered images (glyphs); \
`list_glyphs` gives the vocabulary, and an unregistered `:name:` stays \
literal text. When write tools are present, every overwrite first saves a \
copy that `restore_note` can bring back; the newest 20 copies of each note \
are kept.";

/// Write tools are listed only when they are asked for.
///
/// If the public app's MCP could write by default, a setup meant to be read-only would
/// rewrite the journal.
const WRITE_TOOLS: [&str; 6] = [
    "create_note",
    "update_note",
    "list_note_history",
    "read_note_history",
    "restore_note",
    "save_glyph",
];

pub(crate) struct McpServer {
    data_dir: PathBuf,
    locale: String,
    /// The instructions sent to the client. Chosen at startup so they cannot disagree
    /// with the tools that are listed.
    instructions: String,
    tool_router: ToolRouter<Self>,
}

impl McpServer {
    pub(crate) fn new(data_dir: PathBuf, locale: String, allow_write: bool) -> Self {
        let mut tool_router = Self::tool_router();
        if !allow_write {
            // Hide them rather than refuse. A tool that is listed but refused every time
            // gives the model no use other than trying again
            for name in WRITE_TOOLS {
                tool_router.remove_route(name);
            }
        }
        let opening = if allow_write {
            WRITABLE_OPENING
        } else {
            READ_ONLY_OPENING
        };
        Self {
            data_dir,
            locale,
            instructions: format!("{opening}{INSTRUCTIONS_BODY}"),
            tool_router,
        }
    }

    fn places(&self) -> PlaceCache {
        PlaceCache::load(&place_cache_path(&self.data_dir))
    }

    fn place_name(&self, cache: &PlaceCache, latitude: f64, longitude: f64) -> Option<String> {
        cache
            .lookup(&self.locale, &place_key(latitude, longitude))
            .map(str::to_string)
    }

    fn day_entries(&self, cache: &PlaceCache, date: NaiveDate) -> Result<Vec<EntryInfo>, String> {
        let formatted = date.format("%Y-%m-%d").to_string();
        let lines =
            magical_merchant_core::read_scrawl(&self.data_dir, date).map_err(|e| e.to_string())?;
        Ok(lines
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let entry = parse_scrawl_entry(line);
                let place = entry
                    .context
                    .location
                    .as_ref()
                    .and_then(|l| self.place_name(cache, l.latitude, l.longitude));
                EntryInfo::new(&formatted, index, entry, place)
            })
            .collect())
    }
}

// --- Parameter types ---

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct FilenameParam {
    /// The note filename, e.g. `20260320_143045.md`
    filename: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct QueryParam {
    /// Substring to look for; matching ignores case. May be empty when `tags` is given
    query: String,
    /// Only records carrying every one of these `#tags` (with or without the `#`,
    /// case-insensitive). With an empty `query`, lists every record carrying them
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct DateParam {
    /// The day to read, in YYYY-MM-DD format
    date: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct RangeParam {
    /// First day to read, inclusive, YYYY-MM-DD
    from: String,
    /// Last day to read, inclusive, YYYY-MM-DD
    to: String,
    /// Only entries whose text carries this `#tag` (without the `#`)
    tag: Option<String>,
    /// Maximum number of entries to return (default 500)
    limit: Option<usize>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct CreateNoteParam {
    /// Markdown body. The first line should be a `# Title` heading — that is
    /// the note's title. Fenced `mermaid` code blocks render as diagrams;
    /// `[[YYYYMMDD_HHMMSS]]` links another note by filename stem; `:name:`
    /// renders a registered glyph image (see `list_glyphs` for the names).
    body: String,
    /// Tags to record in the frontmatter (without the `#`). Tags written as
    /// `#tag` in the body are picked up automatically.
    tags: Option<Vec<String>>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct UpdateNoteParam {
    /// The note filename, e.g. `20260320_143045.md`
    filename: String,
    /// The complete new Markdown body; replaces the old one. The frontmatter
    /// (creation time, tags, device context) is preserved by the server.
    /// `:name:` renders a registered glyph image (see `list_glyphs`).
    body: String,
    /// The `revision` that `read_note` returned. When given, the write is
    /// refused if the note changed since that read, so an edit made in the
    /// app or elsewhere in the meantime is not silently overwritten.
    revision: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct SaveGlyphParam {
    /// The glyph name: lowercase letters, digits, `_`, `+`, `-`; starts with
    /// a letter or digit; at most 32 characters. Bodies refer to it as
    /// `:name:`. Saving an existing name replaces its image.
    name: String,
    /// `png` or `svg`
    format: String,
    /// The image bytes, standard base64. At most 256 KiB decoded.
    data_base64: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct HistoryParam {
    /// The note filename, e.g. `20260320_143045.md`
    filename: String,
    /// A snapshot id from `list_note_history` or `update_note`
    id: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct RestoreNoteParam {
    /// The note filename, e.g. `20260320_143045.md`
    filename: String,
    /// A snapshot id from `list_note_history` or `update_note`
    id: String,
    /// The `revision` that `read_note` or `read_note_history` returned for the
    /// note as it stands now. When given, the restore is refused if the note
    /// changed since that read, so an edit made in the app in the meantime is
    /// not silently thrown away.
    revision: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub(crate) struct TemplateParam {
    /// The template filename, e.g. `daily.md`
    filename: String,
}

fn parse_date(text: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").map_err(|e| format!("Invalid date '{text}': {e}"))
}

fn parse_filename(text: &str) -> Result<NoteFilename, String> {
    NoteFilename::parse(text).map_err(|e| e.to_string())
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tool_router]
impl McpServer {
    #[tool(
        name = "list_notes",
        description = "List all notes, newest first, with their tags, a short preview, and where they came from. `kind` is `codex` for a document that grows and keeps versions"
    )]
    fn list_notes(&self) -> Result<Json<NoteListOutput>, String> {
        let notes = magical_merchant_core::list_notes(&self.data_dir).map_err(err)?;
        Ok(Json(NoteListOutput {
            notes: notes.into_iter().map(Into::into).collect(),
        }))
    }

    #[tool(
        name = "read_note",
        description = "Read a note by filename: its metadata (time, tags, device context) and the Markdown body"
    )]
    fn read_note(
        &self,
        Parameters(param): Parameters<FilenameParam>,
    ) -> Result<Json<NoteOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let notes::Read { body, revision } = notes::read(&self.data_dir, &filename).map_err(err)?;
        // Broken frontmatter still returns the body. The list does the same: metadata that
        // cannot be read is no reason to hide the body as well.
        let meta = magical_merchant_core::read_note_meta(&self.data_dir, &filename).ok();
        let cache = self.places();
        let context = meta.as_ref().and_then(|m| m.context.as_ref()).map(|ctx| {
            let place = ctx
                .location
                .as_ref()
                .and_then(|l| self.place_name(&cache, l.latitude, l.longitude));
            ContextInfo::from_context(ctx, place)
        });
        let (time, updated, tags, origin, template, view, source) = meta.map_or_else(
            || (None, None, Vec::new(), None, None, None, None),
            |m| {
                (
                    Some(m.time.to_rfc3339()),
                    m.updated.map(|t| t.to_rfc3339()),
                    m.tags,
                    m.origin,
                    m.template,
                    m.view,
                    m.source,
                )
            },
        );
        Ok(Json(NoteOutput {
            filename: filename.as_str().to_string(),
            time,
            updated,
            // Merge by the same rule as the list. Showing only the frontmatter tags or only
            // the body tags makes one note claim different tags in the list and on its own.
            tags: magical_merchant_core::utils::tags::merge(tags, &body),
            origin,
            template,
            view,
            source,
            context,
            revision: revision.to_string(),
            body,
        }))
    }

    #[tool(
        name = "backlinks",
        description = "List the notes and scrawl entries that link to a note with [[filename-stem]]"
    )]
    fn backlinks(
        &self,
        Parameters(param): Parameters<FilenameParam>,
    ) -> Result<Json<SearchOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let hits = magical_merchant_core::find_backlinks(&self.data_dir, &filename).map_err(err)?;
        Ok(Json(SearchOutput {
            hits: hits.into_iter().map(Into::into).collect(),
        }))
    }

    #[tool(
        name = "search",
        description = "Search notes and scrawl entries for a substring, ignoring case; newest first. Pass `tags` to search only records carrying every listed #tag, or `tags` with an empty query to list every record carrying them"
    )]
    fn search(
        &self,
        Parameters(param): Parameters<QueryParam>,
    ) -> Result<Json<SearchOutput>, String> {
        let hits = magical_merchant_core::search_all(&self.data_dir, &param.query, &param.tags)
            .map_err(err)?;
        Ok(Json(SearchOutput {
            hits: hits.into_iter().map(Into::into).collect(),
        }))
    }

    #[tool(
        name = "list_scrawl_dates",
        description = "List the dates (YYYY-MM-DD) that have scrawl entries, newest first"
    )]
    fn list_scrawl_dates(&self) -> Result<Json<ScrawlDatesOutput>, String> {
        let dates = magical_merchant_core::list_scrawl_dates(&self.data_dir).map_err(err)?;
        Ok(Json(ScrawlDatesOutput {
            dates: dates
                .iter()
                .map(|d| d.format("%Y-%m-%d").to_string())
                .collect(),
        }))
    }

    #[tool(
        name = "read_scrawl",
        description = "Read every scrawl entry of one day (YYYY-MM-DD) with its time, text, tags, location, and device context"
    )]
    fn read_scrawl(
        &self,
        Parameters(param): Parameters<DateParam>,
    ) -> Result<Json<ScrawlOutput>, String> {
        let date = parse_date(&param.date)?;
        let entries = self.day_entries(&self.places(), date)?;
        Ok(Json(ScrawlOutput {
            entries,
            truncated: false,
        }))
    }

    #[tool(
        name = "read_scrawl_range",
        description = "Read scrawl entries between two days (inclusive), oldest first, optionally filtered by tag; use this to line records up with other time-based data"
    )]
    fn read_scrawl_range(
        &self,
        Parameters(param): Parameters<RangeParam>,
    ) -> Result<Json<ScrawlOutput>, String> {
        let from = parse_date(&param.from)?;
        let to = parse_date(&param.to)?;
        if from > to {
            return Err(format!("'from' ({from}) is after 'to' ({to})"));
        }
        let limit = param.limit.unwrap_or(DEFAULT_LIMIT);
        // Callers do not type the exact spelling they saw in the list. The `#` and the case
        // are ignored
        let tag = param
            .tag
            .map(|t| magical_merchant_core::utils::tags::normalize(&t));
        let cache = self.places();

        let mut entries = Vec::new();
        let mut truncated = false;
        // Narrow down from the list of dates. Opening every day in the range piles up a
        // wasted stat for each day that was never written.
        let mut dates: Vec<NaiveDate> = magical_merchant_core::list_scrawl_dates(&self.data_dir)
            .map_err(err)?
            .into_iter()
            .filter(|d| (from..=to).contains(d))
            .collect();
        dates.sort_unstable();
        'days: for date in dates {
            for entry in self.day_entries(&cache, date)? {
                if tag.as_ref().is_some_and(|t| {
                    !entry
                        .tags
                        .iter()
                        .any(|own| magical_merchant_core::utils::tags::same_tag(own, t))
                }) {
                    continue;
                }
                if entries.len() >= limit {
                    truncated = true;
                    break 'days;
                }
                entries.push(entry);
            }
        }
        Ok(Json(ScrawlOutput { entries, truncated }))
    }

    #[tool(
        name = "list_places",
        description = "List the places (~1 km grid cells) records were written at, with names when known, most-visited first"
    )]
    fn list_places(&self) -> Result<Json<PlacesOutput>, String> {
        let cache = self.places();
        let mut cells: BTreeMap<String, PlaceInfo> = BTreeMap::new();
        let mut visit = |latitude: f64, longitude: f64, date: &str, is_note: bool| {
            let key = place_key(latitude, longitude);
            let cell = cells.entry(key.clone()).or_insert_with(|| PlaceInfo {
                latitude: round_to_key(latitude),
                longitude: round_to_key(longitude),
                place: self.place_name(&cache, latitude, longitude),
                place_key: key,
                entries: 0,
                notes: 0,
                first: date.to_string(),
                last: date.to_string(),
            });
            if is_note {
                cell.notes += 1;
            } else {
                cell.entries += 1;
            }
            if date < cell.first.as_str() {
                cell.first = date.to_string();
            }
            if date > cell.last.as_str() {
                cell.last = date.to_string();
            }
        };

        for date in magical_merchant_core::list_scrawl_dates(&self.data_dir).map_err(err)? {
            let formatted = date.format("%Y-%m-%d").to_string();
            for line in magical_merchant_core::read_scrawl(&self.data_dir, date).map_err(err)? {
                if let Some(l) = parse_scrawl_entry(&line).context.location {
                    visit(l.latitude, l.longitude, &formatted, false);
                }
            }
        }
        for note in magical_merchant_core::list_notes(&self.data_dir).map_err(err)? {
            // A note that cannot be read only misses the map. That is no reason to stop the
            // listing
            let Ok(filename) = NoteFilename::parse(&note.filename) else {
                continue;
            };
            let Ok(meta) = magical_merchant_core::read_note_meta(&self.data_dir, &filename) else {
                continue;
            };
            if let Some(l) = meta.context.and_then(|c| c.location) {
                let date = meta.time.format("%Y-%m-%d").to_string();
                visit(l.latitude, l.longitude, &date, true);
            }
        }

        let mut places: Vec<PlaceInfo> = cells.into_values().collect();
        places.sort_by_key(|p| std::cmp::Reverse(p.entries + p.notes));
        Ok(Json(PlacesOutput { places }))
    }

    #[tool(
        name = "list_tags",
        description = "List every #tag used across notes and scrawl entries with usage counts, most-used first"
    )]
    fn list_tags(&self) -> Result<Json<TagsOutput>, String> {
        use magical_merchant_core::utils::tags;

        // The key is the folded form; the name shown is the first spelling seen. If
        // `#CognitiveBias` and `#cognitivebias` split into two rows, there is no telling
        // which one to type. `notes`/`entries` are how many notes and how many entries
        // carry the tag. One record never claims the same tag twice because `tags::merge`
        // and `tags::parse` fold before returning; nothing is folded again per record here
        let mut counts: BTreeMap<String, (String, usize, usize)> = BTreeMap::new();
        for note in magical_merchant_core::list_notes(&self.data_dir).map_err(err)? {
            for tag in note.tags {
                counts.entry(tags::fold_tag(&tag)).or_insert((tag, 0, 0)).1 += 1;
            }
        }
        for date in magical_merchant_core::list_scrawl_dates(&self.data_dir).map_err(err)? {
            for line in magical_merchant_core::read_scrawl(&self.data_dir, date).map_err(err)? {
                let entry = parse_scrawl_entry(&line);
                for tag in tags::parse(&entry.text) {
                    counts.entry(tags::fold_tag(&tag)).or_insert((tag, 0, 0)).2 += 1;
                }
            }
        }
        let mut tags: Vec<TagInfo> = counts
            .into_values()
            .map(|(tag, notes, entries)| TagInfo {
                tag,
                notes,
                entries,
            })
            .collect();
        tags.sort_by_key(|t| std::cmp::Reverse(t.notes + t.entries));
        Ok(Json(TagsOutput { tags }))
    }

    #[tool(
        name = "create_note",
        description = "Create a new note from a Markdown body (first line `# Title`); returns its filename"
    )]
    fn create_note(
        &self,
        Parameters(param): Parameters<CreateNoteParam>,
    ) -> Result<Json<CreatedNoteOutput>, String> {
        let tags = param.tags.unwrap_or_default();
        let created = notes::create(
            &self.data_dir,
            &param.body,
            &tags,
            // This goes through the same `notes::create` as the CLI, so without naming the
            // source a note written by an agent cannot be told from one written by hand
            Provenance {
                source: Some(Source::Mcp),
                ..Provenance::default()
            },
        )
        .map_err(err)?
        .ok_or_else(|| "body is empty".to_string())?;
        Ok(Json(CreatedNoteOutput {
            filename: created.as_str().to_string(),
        }))
    }

    #[tool(
        name = "update_note",
        description = "Replace a note's Markdown body, keeping its frontmatter; a copy of the previous version is saved first and can be brought back with restore_note (the newest 20 copies per note are kept)"
    )]
    fn update_note(
        &self,
        Parameters(param): Parameters<UpdateNoteParam>,
    ) -> Result<Json<UpdatedNoteOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let expected = param.revision.map(Revision::from);
        let written = notes::overwrite(&self.data_dir, &filename, &param.body, expected.as_ref())
            .map_err(err)?;
        Ok(Json(UpdatedNoteOutput {
            filename: filename.as_str().to_string(),
            snapshot: Some(written.snapshot.into()),
            revision: Some(written.revision.to_string()),
        }))
    }

    #[tool(
        name = "list_note_history",
        description = "List the saved copies of a note taken before each write, newest first"
    )]
    fn list_note_history(
        &self,
        Parameters(param): Parameters<FilenameParam>,
    ) -> Result<Json<HistoryOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let snapshots =
            magical_merchant_core::list_note_history(&self.data_dir, &filename).map_err(err)?;
        Ok(Json(HistoryOutput {
            snapshots: snapshots.into_iter().map(Into::into).collect(),
        }))
    }

    #[tool(
        name = "read_note_history",
        description = "Read the body of one saved copy of a note"
    )]
    fn read_note_history(
        &self,
        Parameters(param): Parameters<HistoryParam>,
    ) -> Result<Json<HistoryVersionOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let content =
            magical_merchant_core::read_note_history(&self.data_dir, &filename, &param.id)
                .map_err(err)?;
        Ok(Json(HistoryVersionOutput {
            id: param.id,
            body: frontmatter::strip(&content).to_string(),
            // The revision to pass back when restoring. It is of the note's body as it
            // stands now, not of the saved copy's body
            revision: notes::read(&self.data_dir, &filename)
                .ok()
                .map(|r| r.revision.to_string()),
        }))
    }

    #[tool(
        name = "restore_note",
        description = "Bring a note back to a saved copy; the current version is saved first so the restore itself can be undone (the newest 20 copies per note are kept). Pass the revision you last read so an edit made in the meantime is not thrown away"
    )]
    fn restore_note(
        &self,
        Parameters(param): Parameters<RestoreNoteParam>,
    ) -> Result<Json<UpdatedNoteOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let expected = param.revision.map(Revision::from);
        let snapshot = magical_merchant_core::restore_note(
            &self.data_dir,
            &filename,
            &param.id,
            expected.as_ref(),
        )
        .map_err(err)?;
        Ok(Json(UpdatedNoteOutput {
            filename: filename.as_str().to_string(),
            snapshot: snapshot.map(Into::into),
            revision: notes::read(&self.data_dir, &filename)
                .ok()
                .map(|r| r.revision.to_string()),
        }))
    }

    #[tool(
        name = "list_templates",
        description = "List the note templates with their tags and first line"
    )]
    fn list_templates(&self) -> Result<Json<TemplateListOutput>, String> {
        let templates = magical_merchant_core::list_templates(&self.data_dir).map_err(err)?;
        Ok(Json(TemplateListOutput {
            templates: templates.into_iter().map(Into::into).collect(),
        }))
    }

    #[tool(
        name = "read_template",
        description = "Read a note template's body and tags, with {{variables}} left unresolved"
    )]
    fn read_template(
        &self,
        Parameters(param): Parameters<TemplateParam>,
    ) -> Result<Json<TemplateOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let detail =
            magical_merchant_core::read_template(&self.data_dir, &filename).map_err(err)?;
        Ok(Json(TemplateOutput {
            body: detail.body,
            tags: detail.tags,
        }))
    }

    #[tool(
        name = "list_glyphs",
        description = "List the user-registered glyph images and the `:name:` shortcode that renders each one inline in a note or scrawl entry"
    )]
    fn list_glyphs(&self) -> Result<Json<GlyphListOutput>, String> {
        let glyphs = magical_merchant_core::list_glyphs(&self.data_dir).map_err(err)?;
        Ok(Json(GlyphListOutput {
            glyphs: glyphs.into_iter().map(Into::into).collect(),
        }))
    }

    #[tool(
        name = "save_glyph",
        description = "Register (or replace) a glyph image under a short name so that `:name:` renders it inline; png or svg, base64, at most 256 KiB"
    )]
    fn save_glyph(
        &self,
        Parameters(param): Parameters<SaveGlyphParam>,
    ) -> Result<Json<SavedGlyphOutput>, String> {
        let name = GlyphName::parse(&param.name).map_err(err)?;
        let format = GlyphFormat::parse(&param.format).map_err(err)?;
        let bytes = B64.decode(param.data_base64).map_err(err)?;
        magical_merchant_core::save_glyph(&self.data_dir, &name, format, &bytes).map_err(err)?;
        Ok(Json(SavedGlyphOutput {
            shortcode: format!(":{name}:"),
            name: name.as_str().to_string(),
        }))
    }
}

/// The same rounding as `place_key`. The key is a string, so returning a number rounds again.
fn round_to_key(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build());
        info.server_info.name = "magical-merchant".into();
        info.server_info.version = env!("CARGO_PKG_VERSION").into();
        info.instructions = Some(self.instructions.clone());
        info
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        let items = self.tool_router.list_all();
        std::future::ready(Ok(ListToolsResult::with_all_items(items)))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }
}

/// Lives here so that the tests and `main` see the same default.
pub(crate) fn exists_or_hint(data_dir: &Path) -> Result<(), String> {
    if data_dir.is_dir() {
        return Ok(());
    }
    Err(format!(
        "data directory not found: {}\nRun the app once, or pass --data-dir / MAGICAL_MERCHANT_DATA_DIR",
        data_dir.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};
    use magical_merchant_core::utils::device::{Context, Location};
    use magical_merchant_core::utils::markdown::format_scrawl_line;
    use magical_merchant_core::utils::place::cache_key;
    use std::fs;
    use tempfile::TempDir;

    fn shibuya() -> Location {
        Location {
            latitude: 35.6762,
            longitude: 139.6503,
        }
    }

    fn mac_at_shibuya() -> Context {
        Context {
            battery: Some(56),
            location: Some(shibuya()),
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            hostname: Some("MacBook".to_string()),
            ..Context::default()
        }
    }

    /// Writes at a fixed date. `save_scrawl_entry` can only write today.
    fn write_day(base: &Path, date: &str, entries: &[(u32, &str, &Context)]) {
        let dir = base.join("data/scrawl");
        fs::create_dir_all(&dir).unwrap();
        let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
        let lines: Vec<String> = entries
            .iter()
            .map(|(hour, text, ctx)| {
                let at = Local
                    .from_local_datetime(&day.and_hms_opt(*hour, 0, 0).unwrap())
                    .unwrap();
                format_scrawl_line(text, at, ctx)
            })
            .collect();
        fs::write(dir.join(format!("{date}.md")), lines.join("\n") + "\n").unwrap();
    }

    fn name_shibuya(base: &Path, locale: &str) {
        let mut cache = PlaceCache::default();
        cache.insert(
            cache_key(locale, &place_key(35.6762, 139.6503)),
            "渋谷区".to_string(),
        );
        cache.save(&place_cache_path(base)).unwrap();
    }

    fn server(base: &Path) -> McpServer {
        McpServer::new(base.to_path_buf(), "ja".to_string(), false)
    }

    fn writable(base: &Path) -> McpServer {
        McpServer::new(base.to_path_buf(), "ja".to_string(), true)
    }

    fn tool_names(server: &McpServer) -> Vec<String> {
        server
            .tool_router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect()
    }

    fn range(server: &McpServer, from: &str, to: &str, tag: Option<&str>) -> ScrawlOutput {
        server
            .read_scrawl_range(Parameters(RangeParam {
                from: from.to_string(),
                to: to.to_string(),
                tag: tag.map(str::to_string),
                limit: None,
            }))
            .unwrap()
            .0
    }

    #[test]
    fn an_entry_comes_back_as_values_not_a_line() {
        let tmp = TempDir::new().unwrap();
        write_day(
            tmp.path(),
            "2026-04-30",
            &[(9, "朝 #run", &mac_at_shibuya())],
        );
        name_shibuya(tmp.path(), "ja");

        let out = server(tmp.path())
            .read_scrawl(Parameters(DateParam {
                date: "2026-04-30".to_string(),
            }))
            .unwrap()
            .0;

        let entry = &out.entries[0];
        assert_eq!(entry.datetime.as_deref(), Some("2026-04-30T09:00:00"));
        assert_eq!(entry.text, "朝 #run");
        assert_eq!(entry.tags, vec!["run"]);
        assert_eq!(entry.context.battery, Some(56));
        let location = entry.context.location.as_ref().unwrap();
        assert_eq!(location.place.as_deref(), Some("渋谷区"));
        assert_eq!(location.place_key, "35.68,139.65");
        assert_eq!(
            entry.context.device.as_ref().unwrap().hostname.as_deref(),
            Some("MacBook")
        );
    }

    /// An old line carries neither device nor coordinates. What is absent is not shown as
    /// an empty box.
    #[test]
    fn a_bare_entry_has_no_device_or_location() {
        let tmp = TempDir::new().unwrap();
        write_day(
            tmp.path(),
            "2026-04-30",
            &[(9, "bare", &Context::default())],
        );

        let out = server(tmp.path())
            .read_scrawl(Parameters(DateParam {
                date: "2026-04-30".to_string(),
            }))
            .unwrap()
            .0;

        assert!(out.entries[0].context.device.is_none());
        assert!(out.entries[0].context.location.is_none());
    }

    #[test]
    fn a_range_spans_days_oldest_first_and_skips_days_outside() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(tmp.path(), "2026-01-15", &[(9, "jan", &ctx)]);
        write_day(tmp.path(), "2026-02-10", &[(9, "feb", &ctx)]);
        write_day(tmp.path(), "2026-03-01", &[(9, "mar", &ctx)]);

        let out = range(&server(tmp.path()), "2026-01-15", "2026-02-28", None);

        let texts: Vec<&str> = out.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["jan", "feb"]);
        assert!(!out.truncated);
    }

    #[test]
    fn a_range_filters_by_tag_with_or_without_the_hash() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, "走った #run", &ctx), (10, "休憩", &ctx)],
        );

        let server = server(tmp.path());
        assert_eq!(
            range(&server, "2026-01-01", "2026-12-31", Some("run"))
                .entries
                .len(),
            1
        );
        assert_eq!(
            range(&server, "2026-01-01", "2026-12-31", Some("#run"))
                .entries
                .len(),
            1
        );
    }

    /// An agent does not always pass the spelling it saw in the list.
    /// Either side, the record or the argument, may be uppercase and still hit the entry.
    #[test]
    fn a_range_filters_by_tag_ignoring_case() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, "歪みを疑う #CognitiveBias", &ctx), (10, "休憩", &ctx)],
        );

        let server = server(tmp.path());
        let hit = range(&server, "2026-01-01", "2026-12-31", Some("cognitivebias"));
        assert_eq!(hit.entries.len(), 1);
        // The recorded spelling comes back unchanged
        assert_eq!(hit.entries[0].tags, vec!["CognitiveBias"]);
        assert_eq!(
            range(&server, "2026-01-01", "2026-12-31", Some("#COGNITIVEBIAS"))
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn a_range_stops_at_the_limit_and_says_so() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, "a", &ctx), (10, "b", &ctx), (11, "c", &ctx)],
        );

        let out = server(tmp.path())
            .read_scrawl_range(Parameters(RangeParam {
                from: "2026-01-01".to_string(),
                to: "2026-12-31".to_string(),
                tag: None,
                limit: Some(2),
            }))
            .unwrap()
            .0;

        assert_eq!(out.entries.len(), 2);
        assert!(out.truncated);
    }

    #[test]
    fn a_backwards_range_is_refused() {
        let tmp = TempDir::new().unwrap();

        let result = server(tmp.path()).read_scrawl_range(Parameters(RangeParam {
            from: "2026-02-01".to_string(),
            to: "2026-01-01".to_string(),
            tag: None,
            limit: None,
        }));

        assert_eq!(
            result.err(),
            Some("'from' (2026-02-01) is after 'to' (2026-01-01)".to_string())
        );
    }

    /// Both ends are inclusive. `from == to` is a range of one day, not a backwards range.
    #[test]
    fn a_range_of_a_single_day_is_inclusive_on_both_ends() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(tmp.path(), "2026-01-14", &[(9, "eve", &ctx)]);
        write_day(tmp.path(), "2026-01-15", &[(9, "day", &ctx)]);
        write_day(tmp.path(), "2026-01-16", &[(9, "next", &ctx)]);

        let out = range(&server(tmp.path()), "2026-01-15", "2026-01-15", None);

        let texts: Vec<&str> = out.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["day"]);
    }

    #[test]
    fn places_are_counted_per_grid_cell_across_entries_and_notes() {
        let tmp = TempDir::new().unwrap();
        let here = mac_at_shibuya();
        let nearby = Context {
            location: Some(Location {
                latitude: 35.6769,
                longitude: 139.6509,
            }),
            ..Context::default()
        };
        let far = Context {
            location: Some(Location {
                latitude: 43.06,
                longitude: 141.35,
            }),
            ..Context::default()
        };
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, "a", &here), (10, "b", &nearby)],
        );
        write_day(tmp.path(), "2026-03-01", &[(9, "c", &far)]);
        magical_merchant_core::create_draft_note(
            tmp.path(),
            "note",
            &[],
            &here,
            Provenance::default(),
        )
        .unwrap();
        name_shibuya(tmp.path(), "en");

        let out = server(tmp.path()).list_places().unwrap().0;

        assert_eq!(out.places.len(), 2);
        let shibuya = &out.places[0];
        assert_eq!(shibuya.place_key, "35.68,139.65");
        assert_eq!(shibuya.entries, 2);
        assert_eq!(shibuya.notes, 1);
        assert_eq!(shibuya.first, "2026-01-15");
        // The cache entry was written under en, but asking in ja still gives the name
        assert_eq!(shibuya.place.as_deref(), Some("渋谷区"));
        assert_eq!(out.places[1].place, None);
        assert_eq!(out.places[1].entries, 1);
    }

    #[test]
    fn tags_are_counted_across_notes_and_entries() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, "#run 朝", &ctx), (10, "#run 夜 #rest", &ctx)],
        );
        magical_merchant_core::create_draft_note(
            tmp.path(),
            "設計 #rust",
            &[],
            &ctx,
            Provenance::default(),
        )
        .unwrap();

        let out = server(tmp.path()).list_tags().unwrap().0;

        let run = out.tags.iter().find(|t| t.tag == "run").unwrap();
        assert_eq!((run.notes, run.entries), (0, 2));
        let rust = out.tags.iter().find(|t| t.tag == "rust").unwrap();
        assert_eq!((rust.notes, rust.entries), (1, 0));
        assert_eq!(out.tags[0].tag, "run");
    }

    /// `#CognitiveBias` and `#cognitivebias` differ only in spelling and are one tag.
    /// Listed twice, there is no telling which one to type.
    #[test]
    fn tags_that_differ_only_in_case_are_counted_as_one() {
        let tmp = TempDir::new().unwrap();
        let ctx = Context::default();
        write_day(
            tmp.path(),
            "2026-01-15",
            &[(9, "また #cognitivebias", &ctx)],
        );
        magical_merchant_core::create_draft_note(
            tmp.path(),
            "歪みを疑う #CognitiveBias",
            &[],
            &ctx,
            Provenance::default(),
        )
        .unwrap();

        let out = server(tmp.path()).list_tags().unwrap().0;

        assert_eq!(out.tags.len(), 1);
        // Named by the first spelling seen
        assert_eq!(out.tags[0].tag, "CognitiveBias");
        assert_eq!((out.tags[0].notes, out.tags[0].entries), (1, 1));
    }

    /// `notes` is how many notes carry the tag.
    ///
    /// frontmatter arrives as written, so one note can claim both `Memo` and `memo`.
    /// Without folded counting that one note looks like two, which moves the order too.
    #[test]
    fn one_note_naming_a_tag_in_two_cases_counts_once() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("data/notes");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("20260115_090000.md"),
            "---\ntime: 2026-01-15T09:00:00+09:00\ntags:\n  - Memo\n  - memo\n---\n\n# 走り書き\n",
        )
        .unwrap();

        let out = server(tmp.path()).list_tags().unwrap().0;

        assert_eq!(out.tags.len(), 1);
        assert_eq!(out.tags[0].tag, "Memo");
        assert_eq!((out.tags[0].notes, out.tags[0].entries), (1, 0));
    }

    #[test]
    fn a_note_comes_back_as_metadata_plus_body() {
        let tmp = TempDir::new().unwrap();
        let path = magical_merchant_core::create_draft_note(
            tmp.path(),
            "# 題\n本文 #rust",
            &["Memo".to_string()],
            &mac_at_shibuya(),
            Provenance::default(),
        )
        .unwrap();
        name_shibuya(tmp.path(), "ja");
        let filename = path.file_name().unwrap().to_str().unwrap().to_string();

        let out = server(tmp.path())
            .read_note(Parameters(FilenameParam { filename }))
            .unwrap()
            .0;

        assert_eq!(out.body, "# 題\n本文 #rust");
        assert!(!out.body.contains("---"));
        // Comes out with the spelling as written in the frontmatter
        assert_eq!(out.tags, vec!["Memo", "rust"]);
        assert!(out.time.is_some());
        assert_eq!(out.updated, None);
        let context = out.context.unwrap();
        assert_eq!(context.battery, Some(56));
        assert_eq!(context.location.unwrap().place.as_deref(), Some("渋谷区"));
    }

    #[test]
    fn a_missing_data_dir_names_the_path_and_the_flag() {
        let message = exists_or_hint(Path::new("/nonexistent/magical-merchant")).unwrap_err();

        assert!(message.contains("/nonexistent/magical-merchant"));
        assert!(message.contains("--data-dir"));
    }

    /// A read-only launch lists no write tools. A tool that refuses is not listed.
    #[test]
    fn write_tools_are_absent_unless_asked_for() {
        let tmp = TempDir::new().unwrap();

        let read_only = tool_names(&server(tmp.path()));
        let with_writes = tool_names(&writable(tmp.path()));

        for name in WRITE_TOOLS {
            assert!(!read_only.contains(&name.to_string()), "{name} leaked");
            assert!(with_writes.contains(&name.to_string()), "{name} missing");
        }
    }

    /// The instructions match the tools listed. A writable launch that calls itself
    /// read-only ends up with the same result as removing the tools.
    #[test]
    fn the_instructions_say_which_of_the_two_servers_this_is() {
        let tmp = TempDir::new().unwrap();

        let read_only = server(tmp.path()).get_info().instructions.unwrap();
        let with_writes = writable(tmp.path()).get_info().instructions.unwrap();

        assert!(read_only.starts_with("Read-only access to"));
        assert!(!with_writes.contains("Read-only"));
        assert!(with_writes.starts_with("Read and write access to"));
        // Past the opening, the instructions are the same
        assert!(with_writes.ends_with("the newest 20 copies of each note are kept."));
        assert!(read_only.ends_with("the newest 20 copies of each note are kept."));
    }

    #[test]
    fn a_created_note_has_compliant_frontmatter_and_the_given_body() {
        let tmp = TempDir::new().unwrap();

        let out = writable(tmp.path())
            .create_note(Parameters(CreateNoteParam {
                body: "# 図\n```mermaid\ngraph TD; A-->B;\n```".to_string(),
                tags: Some(vec!["Diagram".to_string()]),
            }))
            .unwrap()
            .0;

        let filename = NoteFilename::parse(&out.filename).unwrap();
        let meta = magical_merchant_core::read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.tags, vec!["Diagram"]);
        assert_eq!(meta.context.unwrap().os, std::env::consts::OS);
        let body = magical_merchant_core::read_note_by_filename(tmp.path(), &filename).unwrap();
        assert!(body.starts_with("# 図\n```mermaid"));
    }

    #[test]
    fn an_empty_body_is_not_a_note() {
        let tmp = TempDir::new().unwrap();

        let result = writable(tmp.path()).create_note(Parameters(CreateNoteParam {
            body: "  \n".to_string(),
            tags: None,
        }));

        assert_eq!(result.err(), Some("body is empty".to_string()));
        // A refusal writes nothing. An empty file left behind puts an "(empty note)" row
        // in the list
        assert!(
            magical_merchant_core::list_notes(tmp.path())
                .unwrap()
                .is_empty()
        );
        assert!(!tmp.path().join("data/notes").exists());
    }

    #[test]
    fn updating_keeps_the_frontmatter_and_leaves_a_way_back() {
        let tmp = TempDir::new().unwrap();
        let server = writable(tmp.path());
        let created = server
            .create_note(Parameters(CreateNoteParam {
                body: "before".to_string(),
                tags: Some(vec!["keep".to_string()]),
            }))
            .unwrap()
            .0;
        let filename = NoteFilename::parse(&created.filename).unwrap();
        let time_before = magical_merchant_core::read_note_meta(tmp.path(), &filename)
            .unwrap()
            .time;

        let updated = server
            .update_note(Parameters(UpdateNoteParam {
                filename: created.filename.clone(),
                body: "after".to_string(),
                revision: None,
            }))
            .unwrap()
            .0;

        let meta = magical_merchant_core::read_note_meta(tmp.path(), &filename).unwrap();
        assert_eq!(meta.time, time_before);
        assert_eq!(meta.tags, vec!["keep"]);
        assert!(meta.updated.is_some());
        assert_eq!(
            magical_merchant_core::read_note_by_filename(tmp.path(), &filename).unwrap(),
            "after"
        );

        let snapshot = updated.snapshot.unwrap();
        let old = server
            .read_note_history(Parameters(HistoryParam {
                filename: created.filename.clone(),
                id: snapshot.id.clone(),
            }))
            .unwrap()
            .0;
        assert_eq!(old.body, "before");

        server
            .restore_note(Parameters(RestoreNoteParam {
                filename: created.filename.clone(),
                id: snapshot.id,
                revision: None,
            }))
            .unwrap();
        assert_eq!(
            magical_merchant_core::read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
        let history = server
            .list_note_history(Parameters(FilenameParam {
                filename: created.filename,
            }))
            .unwrap()
            .0;
        assert_eq!(history.snapshots.len(), 2, "the restore also left a copy");
    }

    /// A restore is also a write that replaces the whole body. Text typed in the app
    /// between reading the history and restoring is protected as `update_note` protects it.
    #[test]
    fn restoring_with_a_stale_revision_is_refused() {
        let tmp = TempDir::new().unwrap();
        let server = writable(tmp.path());
        let created = server
            .create_note(Parameters(CreateNoteParam {
                body: "before".to_string(),
                tags: None,
            }))
            .unwrap()
            .0;
        let filename = NoteFilename::parse(&created.filename).unwrap();
        let updated = server
            .update_note(Parameters(UpdateNoteParam {
                filename: created.filename.clone(),
                body: "after".to_string(),
                revision: None,
            }))
            .unwrap()
            .0;
        let snapshot = updated.snapshot.unwrap();
        // The revision as of reading the saved copy. The intent is to restore from here
        let old = server
            .read_note_history(Parameters(HistoryParam {
                filename: created.filename.clone(),
                id: snapshot.id.clone(),
            }))
            .unwrap()
            .0;
        // The app typed after the read
        magical_merchant_core::update_note(
            &tmp.path().join("data/notes").join(&created.filename),
            "from the app",
            &Context::default(),
            None,
        )
        .unwrap();

        let result = server.restore_note(Parameters(RestoreNoteParam {
            filename: created.filename.clone(),
            id: snapshot.id.clone(),
            revision: old.revision,
        }));

        let Err(message) = result else {
            panic!("a stale revision must be refused");
        };
        assert!(message.contains("changed since it was read"));
        assert_eq!(
            magical_merchant_core::read_note_by_filename(tmp.path(), &filename).unwrap(),
            "from the app"
        );

        // A revision read again goes through
        let fresh = server
            .read_note_history(Parameters(HistoryParam {
                filename: created.filename.clone(),
                id: snapshot.id.clone(),
            }))
            .unwrap()
            .0;
        server
            .restore_note(Parameters(RestoreNoteParam {
                filename: created.filename,
                id: snapshot.id,
                revision: fresh.revision,
            }))
            .unwrap();
        assert_eq!(
            magical_merchant_core::read_note_by_filename(tmp.path(), &filename).unwrap(),
            "before"
        );
    }

    const SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>";

    #[test]
    fn a_saved_glyph_is_listed_with_its_shortcode() {
        let tmp = TempDir::new().unwrap();
        let server = writable(tmp.path());

        let saved = server
            .save_glyph(Parameters(SaveGlyphParam {
                name: "236p".to_string(),
                format: "svg".to_string(),
                data_base64: B64.encode(SVG),
            }))
            .unwrap()
            .0;

        assert_eq!(saved.shortcode, ":236p:");
        let listed = server.list_glyphs().unwrap().0;
        assert_eq!(listed.glyphs.len(), 1);
        assert_eq!(listed.glyphs[0].name, "236p");
        assert_eq!(listed.glyphs[0].shortcode, ":236p:");
        assert_eq!(listed.glyphs[0].format, "svg");
        assert_eq!(listed.glyphs[0].bytes, SVG.len() as u64);
        assert!(tmp.path().join("data/glyphs/236p.svg").exists());
    }

    /// No file is born when the name, the format, or the content is broken.
    #[test]
    fn a_bad_glyph_is_refused_before_anything_is_written() {
        let tmp = TempDir::new().unwrap();
        let server = writable(tmp.path());
        let attempt = |name: &str, format: &str, data: &str| {
            server.save_glyph(Parameters(SaveGlyphParam {
                name: name.to_string(),
                format: format.to_string(),
                data_base64: data.to_string(),
            }))
        };

        assert!(attempt("Bad Name", "svg", &B64.encode(SVG)).is_err());
        assert!(attempt("ok", "gif", &B64.encode(SVG)).is_err());
        assert!(attempt("ok", "png", &B64.encode(SVG)).is_err());
        assert!(attempt("ok", "svg", "not base64!").is_err());
        assert!(server.list_glyphs().unwrap().0.glyphs.is_empty());
    }

    /// `update` must not create a missing note. It would invent frontmatter from the
    /// current time and the file would be born under a name other than the one requested.
    #[test]
    fn updating_a_missing_note_is_refused() {
        let tmp = TempDir::new().unwrap();

        let result = writable(tmp.path()).update_note(Parameters(UpdateNoteParam {
            filename: "20260101_000000.md".to_string(),
            body: "ghost".to_string(),
            revision: None,
        }));

        assert!(result.is_err());
        assert!(!tmp.path().join("data/notes/20260101_000000.md").exists());
    }

    /// Writing with the revision `read_note` returned is refused if the app or the CLI
    /// changed the body in the meantime. Another writer's edit is never silently overwritten.
    #[test]
    fn updating_with_a_stale_revision_is_refused() {
        let tmp = TempDir::new().unwrap();
        let server = writable(tmp.path());
        let created = server
            .create_note(Parameters(CreateNoteParam {
                body: "before".to_string(),
                tags: None,
            }))
            .unwrap()
            .0;
        let read = server
            .read_note(Parameters(FilenameParam {
                filename: created.filename.clone(),
            }))
            .unwrap()
            .0;
        let filename = NoteFilename::parse(&created.filename).unwrap();
        magical_merchant_core::update_note(
            &tmp.path().join("data/notes").join(&created.filename),
            "from the app",
            &Context::default(),
            None,
        )
        .unwrap();

        let result = server.update_note(Parameters(UpdateNoteParam {
            filename: created.filename.clone(),
            body: "from the agent".to_string(),
            revision: Some(read.revision),
        }));

        let Err(message) = result else {
            panic!("a stale revision must be refused");
        };
        assert!(message.contains("changed since it was read"));
        assert_eq!(
            magical_merchant_core::read_note_by_filename(tmp.path(), &filename).unwrap(),
            "from the app"
        );

        // A revision read again goes through
        let fresh = server
            .read_note(Parameters(FilenameParam {
                filename: created.filename.clone(),
            }))
            .unwrap()
            .0;
        let updated = server
            .update_note(Parameters(UpdateNoteParam {
                filename: created.filename,
                body: "from the agent".to_string(),
                revision: Some(fresh.revision),
            }))
            .unwrap()
            .0;
        assert!(updated.revision.is_some());
    }
}
