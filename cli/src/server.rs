use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::NaiveDate;
use magical_merchant_core::utils::frontmatter;
use magical_merchant_core::utils::paths::place_cache_path;
use magical_merchant_core::utils::place::{PlaceCache, place_key};
use magical_merchant_core::{GlyphFormat, GlyphName, NoteFilename, Revision, parse_timeline_entry};
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
    SearchOutput, TagInfo, TagsOutput, TemplateListOutput, TemplateOutput, TimelineDatesOutput,
    TimelineOutput, UpdatedNoteOutput,
};

/// 範囲読みの 1 回あたりの上限。日記は年単位で溜まるので、青天井にすると
/// 1 回の呼び出しがモデルの文脈を使い切る。
const DEFAULT_LIMIT: usize = 500;

const INSTRUCTIONS: &str = "Read-only access to a Magical Merchant journal: \
a Timeline of timestamped entries (one file per day) and Notes (Markdown \
files). Every record carries the device state at the moment it was written: \
local time, GPS coordinates when available, battery, network, and which \
device wrote it. Use `read_timeline_range` to pull entries for a period, \
`list_places` to see where records were written, and `search` to find text. \
Timeline times are the device's local wall-clock time without a UTC offset; \
note times are RFC 3339 with the offset. Bodies may contain `:name:` \
shortcodes that the app renders as user-registered images (glyphs); \
`list_glyphs` gives the vocabulary, and an unregistered `:name:` stays \
literal text. When write tools are present, every overwrite first saves a \
copy that `restore_note` can bring back.";

/// 書き込みは頼まれたときだけ出す。公開アプリの MCP が既定で書けると、
/// 「読ませたつもり」の設定で日記が書き換わる。
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
    tool_router: ToolRouter<Self>,
}

impl McpServer {
    pub(crate) fn new(data_dir: PathBuf, locale: String, allow_write: bool) -> Self {
        let mut tool_router = Self::tool_router();
        if !allow_write {
            // 断るのではなく見せない。並んでいるのに毎回断られる道具は、
            // モデルに「もう一度試す」以外の使い道がない
            for name in WRITE_TOOLS {
                tool_router.remove_route(name);
            }
        }
        Self {
            data_dir,
            locale,
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
        let lines = magical_merchant_core::read_timeline(&self.data_dir, date)
            .map_err(|e| e.to_string())?;
        Ok(lines
            .iter()
            .enumerate()
            .map(|(index, line)| {
                let entry = parse_timeline_entry(line);
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
        description = "List all notes, newest first, with their tags, a short preview, and where they came from"
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
        // 壊れた frontmatter は本文だけ返す。一覧がそうしているのと同じで、
        // メタデータが読めないことを理由に本文まで隠す理由がない。
        let meta = magical_merchant_core::read_note_meta(&self.data_dir, &filename).ok();
        let cache = self.places();
        let context = meta.as_ref().and_then(|m| m.context.as_ref()).map(|ctx| {
            let place = ctx
                .location
                .as_ref()
                .and_then(|l| self.place_name(&cache, l.latitude, l.longitude));
            ContextInfo::from_context(ctx, place)
        });
        let (time, updated, tags, origin, template, view) = meta.map_or_else(
            || (None, None, Vec::new(), None, None, None),
            |m| {
                (
                    Some(m.time.to_rfc3339()),
                    m.updated.map(|t| t.to_rfc3339()),
                    m.tags,
                    m.origin,
                    m.template,
                    m.view,
                )
            },
        );
        Ok(Json(NoteOutput {
            filename: filename.as_str().to_string(),
            time,
            updated,
            // 一覧と同じ規則で合流させる。frontmatter だけ・本文だけの片方を
            // 見せると、同じノートが一覧と単票で違うタグを名乗る。
            tags: magical_merchant_core::utils::tags::merge(tags, &body),
            origin,
            template,
            view,
            context,
            revision: revision.to_string(),
            body,
        }))
    }

    #[tool(
        name = "backlinks",
        description = "List the notes and timeline entries that link to a note with [[filename-stem]]"
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
        description = "Search notes and timeline entries for a substring, ignoring case; newest first. Pass `tags` to search only records carrying every listed #tag, or `tags` with an empty query to list every record carrying them"
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
        name = "list_timeline_dates",
        description = "List the dates (YYYY-MM-DD) that have timeline entries, newest first"
    )]
    fn list_timeline_dates(&self) -> Result<Json<TimelineDatesOutput>, String> {
        let dates = magical_merchant_core::list_timeline_dates(&self.data_dir).map_err(err)?;
        Ok(Json(TimelineDatesOutput {
            dates: dates
                .iter()
                .map(|d| d.format("%Y-%m-%d").to_string())
                .collect(),
        }))
    }

    #[tool(
        name = "read_timeline",
        description = "Read every timeline entry of one day (YYYY-MM-DD) with its time, text, tags, location, and device context"
    )]
    fn read_timeline(
        &self,
        Parameters(param): Parameters<DateParam>,
    ) -> Result<Json<TimelineOutput>, String> {
        let date = parse_date(&param.date)?;
        let entries = self.day_entries(&self.places(), date)?;
        Ok(Json(TimelineOutput {
            entries,
            truncated: false,
        }))
    }

    #[tool(
        name = "read_timeline_range",
        description = "Read timeline entries between two days (inclusive), oldest first, optionally filtered by tag; use this to line records up with other time-based data"
    )]
    fn read_timeline_range(
        &self,
        Parameters(param): Parameters<RangeParam>,
    ) -> Result<Json<TimelineOutput>, String> {
        let from = parse_date(&param.from)?;
        let to = parse_date(&param.to)?;
        if from > to {
            return Err(format!("'from' ({from}) is after 'to' ({to})"));
        }
        let limit = param.limit.unwrap_or(DEFAULT_LIMIT);
        let tag = param.tag.map(|t| t.trim_start_matches('#').to_lowercase());
        let cache = self.places();

        let mut entries = Vec::new();
        let mut truncated = false;
        // 日付一覧から絞る。範囲の全日を開きに行くと、書いていない日の
        // ぶんだけ無駄に stat が積み上がる。
        let mut dates: Vec<NaiveDate> = magical_merchant_core::list_timeline_dates(&self.data_dir)
            .map_err(err)?
            .into_iter()
            .filter(|d| (from..=to).contains(d))
            .collect();
        dates.sort_unstable();
        'days: for date in dates {
            for entry in self.day_entries(&cache, date)? {
                if tag.as_ref().is_some_and(|t| !entry.tags.contains(t)) {
                    continue;
                }
                if entries.len() >= limit {
                    truncated = true;
                    break 'days;
                }
                entries.push(entry);
            }
        }
        Ok(Json(TimelineOutput { entries, truncated }))
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

        for date in magical_merchant_core::list_timeline_dates(&self.data_dir).map_err(err)? {
            let formatted = date.format("%Y-%m-%d").to_string();
            for line in magical_merchant_core::read_timeline(&self.data_dir, date).map_err(err)? {
                if let Some(l) = parse_timeline_entry(&line).context.location {
                    visit(l.latitude, l.longitude, &formatted, false);
                }
            }
        }
        for note in magical_merchant_core::list_notes(&self.data_dir).map_err(err)? {
            // 読めないノートは地図に載らないだけ。一覧を止める理由にはならない
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
        description = "List every #tag used across notes and timeline entries with usage counts, most-used first"
    )]
    fn list_tags(&self) -> Result<Json<TagsOutput>, String> {
        let mut counts: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for note in magical_merchant_core::list_notes(&self.data_dir).map_err(err)? {
            for tag in note.tags {
                counts.entry(tag).or_default().0 += 1;
            }
        }
        for date in magical_merchant_core::list_timeline_dates(&self.data_dir).map_err(err)? {
            for line in magical_merchant_core::read_timeline(&self.data_dir, date).map_err(err)? {
                let entry = parse_timeline_entry(&line);
                for tag in magical_merchant_core::utils::tags::parse(&entry.text) {
                    counts.entry(tag).or_default().1 += 1;
                }
            }
        }
        let mut tags: Vec<TagInfo> = counts
            .into_iter()
            .map(|(tag, (notes, entries))| TagInfo {
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
        if param.body.trim().is_empty() {
            return Err("body is empty".to_string());
        }
        let tags = param.tags.unwrap_or_default();
        let path = magical_merchant_core::create_draft_note(
            &self.data_dir,
            &param.body,
            &tags,
            &notes::context(),
        )
        .map_err(err)?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| "created note has no filename".to_string())?;
        Ok(Json(CreatedNoteOutput {
            filename: filename.to_string(),
        }))
    }

    #[tool(
        name = "update_note",
        description = "Replace a note's Markdown body, keeping its frontmatter; a copy of the previous version is saved first and can be brought back with restore_note"
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
        }))
    }

    #[tool(
        name = "restore_note",
        description = "Bring a note back to a saved copy; the current version is saved first so the restore itself can be undone"
    )]
    fn restore_note(
        &self,
        Parameters(param): Parameters<HistoryParam>,
    ) -> Result<Json<UpdatedNoteOutput>, String> {
        let filename = parse_filename(&param.filename)?;
        let snapshot = magical_merchant_core::restore_note(&self.data_dir, &filename, &param.id)
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
        description = "List the user-registered glyph images and the `:name:` shortcode that renders each one inline in a note or timeline entry"
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

/// `place_key` と同じ丸め。キーは文字列なので、数値で返すにはもう一度丸める。
fn round_to_key(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::builder().enable_tools().build());
        info.server_info.name = "magical-merchant".into();
        info.server_info.version = env!("CARGO_PKG_VERSION").into();
        info.instructions = Some(INSTRUCTIONS.into());
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

/// テストと `main` が同じ既定を見るよう、ここに置く。
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
    use magical_merchant_core::utils::markdown::format_timeline_line;
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

    /// 日付を固定して書く。`save_timeline_entry` は今日にしか書けない。
    fn write_day(base: &Path, date: &str, entries: &[(u32, &str, &Context)]) {
        let dir = base.join("data/timeline");
        fs::create_dir_all(&dir).unwrap();
        let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
        let lines: Vec<String> = entries
            .iter()
            .map(|(hour, text, ctx)| {
                let at = Local
                    .from_local_datetime(&day.and_hms_opt(*hour, 0, 0).unwrap())
                    .unwrap();
                format_timeline_line(text, at, ctx)
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

    fn range(server: &McpServer, from: &str, to: &str, tag: Option<&str>) -> TimelineOutput {
        server
            .read_timeline_range(Parameters(RangeParam {
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
            .read_timeline(Parameters(DateParam {
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

    /// 旧い行は端末も座標も持たない。無いものを空の箱で見せない。
    #[test]
    fn a_bare_entry_has_no_device_or_location() {
        let tmp = TempDir::new().unwrap();
        write_day(
            tmp.path(),
            "2026-04-30",
            &[(9, "bare", &Context::default())],
        );

        let out = server(tmp.path())
            .read_timeline(Parameters(DateParam {
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
            .read_timeline_range(Parameters(RangeParam {
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

        let result = server(tmp.path()).read_timeline_range(Parameters(RangeParam {
            from: "2026-02-01".to_string(),
            to: "2026-01-01".to_string(),
            tag: None,
            limit: None,
        }));

        assert!(result.is_err());
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
        magical_merchant_core::create_draft_note(tmp.path(), "note", &[], &here).unwrap();
        name_shibuya(tmp.path(), "en");

        let out = server(tmp.path()).list_places().unwrap().0;

        assert_eq!(out.places.len(), 2);
        let shibuya = &out.places[0];
        assert_eq!(shibuya.place_key, "35.68,139.65");
        assert_eq!(shibuya.entries, 2);
        assert_eq!(shibuya.notes, 1);
        assert_eq!(shibuya.first, "2026-01-15");
        // 控えは en で書かれているが、ja で聞いても名前は出る
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
        magical_merchant_core::create_draft_note(tmp.path(), "設計 #rust", &[], &ctx).unwrap();

        let out = server(tmp.path()).list_tags().unwrap().0;

        let run = out.tags.iter().find(|t| t.tag == "run").unwrap();
        assert_eq!((run.notes, run.entries), (0, 2));
        let rust = out.tags.iter().find(|t| t.tag == "rust").unwrap();
        assert_eq!((rust.notes, rust.entries), (1, 0));
        assert_eq!(out.tags[0].tag, "run");
    }

    #[test]
    fn a_note_comes_back_as_metadata_plus_body() {
        let tmp = TempDir::new().unwrap();
        let path = magical_merchant_core::create_draft_note(
            tmp.path(),
            "# 題\n本文 #rust",
            &["Memo".to_string()],
            &mac_at_shibuya(),
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
        assert_eq!(out.tags, vec!["memo", "rust"]);
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

    /// 読み取り専用の起動では書く道具が並ばない。断る道具は並べない。
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

        assert!(result.is_err());
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
            .restore_note(Parameters(HistoryParam {
                filename: created.filename.clone(),
                id: snapshot.id,
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

    /// 名前・形式・中身のどれが崩れても、ファイルは生まれない。
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

    /// 無いノートを update で作らせない。frontmatter を今の時刻ででっち上げた
    /// ファイルが、要求したのと違う名前で生まれる。
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

    /// `read_note` が返した revision を添えて書くと、そのあいだにアプリや CLI が
    /// 本文を変えていれば断られる。相手の編集の上に黙って書かない。
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

        // 読み直した revision なら通る
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
