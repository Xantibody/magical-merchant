//! MCP に返す形。core の型をそのまま出さないのは、core が schemars を
//! 知らないのと、外に見せる名前と中の名前を別々に変えられるようにするため。

use magical_merchant_core::utils::device::{Context, NetworkType};
use magical_merchant_core::{
    GlyphSummary, NoteSummary, SearchHit, Snapshot, TemplateSummary, TimelineEntry,
};
use rmcp::schemars;
use serde::Serialize;

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct NoteListOutput {
    pub(crate) notes: Vec<NoteInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct NoteInfo {
    /// The argument to pass to `read_note`.
    pub(crate) filename: String,
    /// Creation time, RFC 3339 with the device's UTC offset.
    pub(crate) time: Option<String>,
    pub(crate) tags: Vec<String>,
    /// First 100 characters of the body.
    pub(crate) preview: String,
    /// Local datetime (`YYYY-MM-DDTHH:MM:SS`) of the timeline entry this note
    /// was promoted from, if any.
    pub(crate) origin: Option<String>,
    /// Name of the template this note was created from, if any.
    pub(crate) template: Option<String>,
}

impl From<NoteSummary> for NoteInfo {
    fn from(n: NoteSummary) -> Self {
        Self {
            filename: n.filename,
            time: n.time.map(|t| t.to_rfc3339()),
            tags: n.tags,
            preview: n.preview,
            origin: n.origin,
            template: n.template,
        }
    }
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct NoteOutput {
    pub(crate) filename: String,
    /// Creation time, RFC 3339 with the device's UTC offset.
    pub(crate) time: Option<String>,
    /// Last body edit, RFC 3339. Absent when the note was never edited.
    pub(crate) updated: Option<String>,
    /// Tags from the frontmatter and from `#tag` in the body, merged.
    pub(crate) tags: Vec<String>,
    pub(crate) origin: Option<String>,
    pub(crate) template: Option<String>,
    /// Per-note view preference (e.g. `mindmap`).
    pub(crate) view: Option<String>,
    /// Which tool created the note: `app`, `cli`, `mcp` or `widget`.
    /// Recorded at creation and never changed by a later edit. Absent on
    /// notes written before this was recorded.
    pub(crate) source: Option<String>,
    /// Device state at creation time.
    pub(crate) context: Option<ContextInfo>,
    /// Fingerprint of `body`. Pass it to `update_note` so the write is
    /// refused if the note changed in the meantime.
    pub(crate) revision: String,
    /// Markdown body without the frontmatter.
    pub(crate) body: String,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct SearchOutput {
    pub(crate) hits: Vec<SearchHitInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct SearchHitInfo {
    /// Which store the hit came from: `timeline` or `note`.
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) snippet: String,
    /// `YYYY-MM-DD`.
    pub(crate) date: String,
    /// Set for note hits; the argument to pass to `read_note`.
    pub(crate) filename: Option<String>,
    /// Set for timeline hits; the entry's position within its day.
    pub(crate) index: Option<usize>,
    pub(crate) tags: Vec<String>,
}

impl From<SearchHit> for SearchHitInfo {
    fn from(h: SearchHit) -> Self {
        let kind = match h.kind {
            magical_merchant_core::HitKind::Timeline => "timeline",
            magical_merchant_core::HitKind::Note => "note",
        };
        Self {
            kind: kind.to_string(),
            title: h.title,
            snippet: h.snippet,
            date: h.date,
            filename: h.filename,
            index: h.index,
            tags: h.tags,
        }
    }
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TimelineDatesOutput {
    /// `YYYY-MM-DD`, newest first.
    pub(crate) dates: Vec<String>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TimelineOutput {
    /// Chronological order.
    pub(crate) entries: Vec<EntryInfo>,
    /// True when more entries matched than were returned.
    pub(crate) truncated: bool,
}

/// One timeline entry with its recorded context flattened into fields an
/// agent can filter and join on.
#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct EntryInfo {
    /// `YYYY-MM-DD`.
    pub(crate) date: String,
    /// Position within the day; pass to `read_timeline` results to refer back.
    pub(crate) index: usize,
    /// Local wall-clock time on the recording device, `HH:MM:SS`. Entries
    /// carry no UTC offset; treat as the device's local time.
    pub(crate) time: Option<String>,
    /// `date` and `time` joined: `YYYY-MM-DDTHH:MM:SS` (local, no offset).
    pub(crate) datetime: Option<String>,
    /// What the user wrote.
    pub(crate) text: String,
    /// `#tags` found in the text.
    pub(crate) tags: Vec<String>,
    /// Which tool wrote the entry: `app`, `cli`, `mcp` or `widget`. Absent
    /// on entries written before this was recorded.
    pub(crate) source: Option<String>,
    /// Device state at recording time. Empty object when nothing was recorded.
    pub(crate) context: ContextInfo,
}

/// Device state at recording time. Every field is optional: older entries
/// and desktops without sensors leave most of it out.
#[derive(Serialize, schemars::JsonSchema, Default)]
pub(crate) struct ContextInfo {
    /// Battery percentage, 0–100.
    pub(crate) battery: Option<u8>,
    pub(crate) is_charging: Option<bool>,
    /// `WiFi`, `Ethernet`, `Mobile`, or `Offline`.
    pub(crate) network_type: Option<String>,
    pub(crate) location: Option<LocationInfo>,
    pub(crate) device: Option<DeviceInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct LocationInfo {
    pub(crate) latitude: f64,
    pub(crate) longitude: f64,
    /// Coordinates rounded to ~1 km; the argument shared with `list_places`.
    pub(crate) place_key: String,
    /// Municipality-level name, when the app has resolved it before.
    pub(crate) place: Option<String>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct DeviceInfo {
    /// `macos`, `android`, `linux`, `windows`, ...
    pub(crate) os: String,
    pub(crate) os_version: Option<String>,
    pub(crate) arch: String,
    pub(crate) hostname: Option<String>,
    /// e.g. `ja_JP`.
    pub(crate) locale: Option<String>,
}

impl ContextInfo {
    /// `place` は呼ぶ側が控えから引く。ここは値の並べ替えだけ。
    pub(crate) fn from_context(ctx: &Context, place: Option<String>) -> Self {
        let network_type = ctx.network_type.as_ref().map(|n| {
            match n {
                NetworkType::WiFi => "WiFi",
                NetworkType::Ethernet => "Ethernet",
                NetworkType::Mobile => "Mobile",
                NetworkType::Offline => "Offline",
            }
            .to_string()
        });
        let location = ctx.location.as_ref().map(|l| LocationInfo {
            latitude: l.latitude,
            longitude: l.longitude,
            place_key: magical_merchant_core::utils::place::place_key(l.latitude, l.longitude),
            place,
        });
        // 端末情報が 1 つも無いエントリで `device: {}` を出さない。旧い行は
        // そもそも端末を記録していないので、空の箱は「不明」を偽って見せる。
        let has_device = !ctx.os.is_empty()
            || !ctx.arch.is_empty()
            || ctx.os_version.is_some()
            || ctx.hostname.is_some()
            || ctx.locale.is_some();
        let device = has_device.then(|| DeviceInfo {
            os: ctx.os.clone(),
            os_version: ctx.os_version.clone(),
            arch: ctx.arch.clone(),
            hostname: ctx.hostname.clone(),
            locale: ctx.locale.clone(),
        });
        Self {
            battery: ctx.battery,
            is_charging: ctx.is_charging,
            network_type,
            location,
            device,
        }
    }
}

impl EntryInfo {
    pub(crate) fn new(
        date: &str,
        index: usize,
        entry: TimelineEntry,
        place: Option<String>,
    ) -> Self {
        let time = entry.time.map(|t| t.format("%H:%M:%S").to_string());
        let datetime = time.as_ref().map(|t| format!("{date}T{t}"));
        Self {
            date: date.to_string(),
            index,
            time,
            datetime,
            tags: magical_merchant_core::utils::tags::parse(&entry.text),
            text: entry.text,
            source: entry.source,
            context: ContextInfo::from_context(&entry.context, place),
        }
    }
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct PlacesOutput {
    /// Most-visited first.
    pub(crate) places: Vec<PlaceInfo>,
}

/// A ~1 km grid cell that at least one record was written in.
#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct PlaceInfo {
    /// Rounded `lat,lon`; matches `context.location.place_key` on entries.
    pub(crate) place_key: String,
    /// Centre of the cell (the rounded coordinates).
    pub(crate) latitude: f64,
    pub(crate) longitude: f64,
    /// Municipality-level name, when the app has resolved it before.
    pub(crate) place: Option<String>,
    /// Timeline entries written here.
    pub(crate) entries: usize,
    /// Notes created here.
    pub(crate) notes: usize,
    /// Earliest and latest `YYYY-MM-DD` seen here.
    pub(crate) first: String,
    pub(crate) last: String,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TagsOutput {
    /// Most-used first.
    pub(crate) tags: Vec<TagInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TagInfo {
    pub(crate) tag: String,
    /// Notes carrying the tag.
    pub(crate) notes: usize,
    /// Timeline entries carrying the tag.
    pub(crate) entries: usize,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TemplateListOutput {
    pub(crate) templates: Vec<TemplateInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TemplateInfo {
    /// The argument to pass to `read_template`.
    pub(crate) filename: String,
    /// Display name; also the value notes record in `template`.
    pub(crate) name: String,
    pub(crate) tags: Vec<String>,
    /// First line, with `{{variables}}` left unresolved.
    pub(crate) preview: String,
}

impl From<TemplateSummary> for TemplateInfo {
    fn from(t: TemplateSummary) -> Self {
        Self {
            filename: t.filename,
            name: t.name,
            tags: t.tags,
            preview: t.preview,
        }
    }
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct TemplateOutput {
    /// Body with `{{variables}}` left unresolved.
    pub(crate) body: String,
    pub(crate) tags: Vec<String>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct GlyphListOutput {
    /// Sorted by name.
    pub(crate) glyphs: Vec<GlyphInfo>,
}

/// A user-registered image that renders inline wherever its shortcode is
/// written. The image bytes are not exposed over MCP.
#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct GlyphInfo {
    pub(crate) name: String,
    /// What to write in a body to show the image, e.g. `:236p:`.
    pub(crate) shortcode: String,
    /// `png` or `svg`.
    pub(crate) format: String,
    pub(crate) bytes: u64,
}

impl From<GlyphSummary> for GlyphInfo {
    fn from(g: GlyphSummary) -> Self {
        Self {
            shortcode: format!(":{}:", g.name),
            name: g.name,
            format: g.format,
            bytes: g.bytes,
        }
    }
}

// --- Write tools ---

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct SavedGlyphOutput {
    pub(crate) name: String,
    /// What to write in a body to show the image from now on.
    pub(crate) shortcode: String,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct CreatedNoteOutput {
    /// The new note's filename; also its permanent id.
    pub(crate) filename: String,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct UpdatedNoteOutput {
    pub(crate) filename: String,
    /// The copy of the note taken before this write. Pass its `id` to
    /// `restore_note` to undo; only the newest 20 copies of a note are kept.
    pub(crate) snapshot: Option<SnapshotInfo>,
    /// Fingerprint of the body now on disk; the `revision` for a further
    /// `update_note`.
    pub(crate) revision: Option<String>,
}

/// One saved copy of a note, taken before a write replaced it.
#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct SnapshotInfo {
    /// The argument to pass to `read_note_history` / `restore_note`.
    /// Valid until 20 newer copies of the same note exist.
    pub(crate) id: String,
    /// When the copy was taken, RFC 3339.
    pub(crate) time: String,
    pub(crate) bytes: u64,
}

impl From<Snapshot> for SnapshotInfo {
    fn from(s: Snapshot) -> Self {
        Self {
            id: s.id,
            time: s.time.to_rfc3339(),
            bytes: s.bytes,
        }
    }
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct HistoryOutput {
    /// Newest first.
    pub(crate) snapshots: Vec<SnapshotInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub(crate) struct HistoryVersionOutput {
    pub(crate) id: String,
    /// Markdown body of that version, without the frontmatter.
    pub(crate) body: String,
}
