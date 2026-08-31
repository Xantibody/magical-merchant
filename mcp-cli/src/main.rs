// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::path::PathBuf;

use chrono::NaiveDate;
use clap::Parser;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, schemars, tool, tool_router};
use serde::{Deserialize, Serialize};

#[derive(Parser)]
#[command(
    name = "magical-merchant-mcp",
    about = "MCP server for magical-merchant"
)]
struct Cli {
    #[arg(long, env = "MAGICAL_MERCHANT_DATA_DIR")]
    data_dir: PathBuf,
}

struct McpServer {
    data_dir: PathBuf,
    tool_router: ToolRouter<Self>,
}

impl McpServer {
    fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            tool_router: Self::tool_router(),
        }
    }
}

// --- Parameter types ---

#[derive(Deserialize, schemars::JsonSchema)]
struct FilenameParam {
    /// The note filename, e.g. `20260320_143045.md`
    filename: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct QueryParam {
    /// Substring to look for; matching ignores case
    query: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct DateParam {
    /// The day to read, in YYYY-MM-DD format
    date: String,
}

// --- Output types ---

#[derive(Serialize, schemars::JsonSchema)]
struct NoteListOutput {
    notes: Vec<NoteInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct NoteInfo {
    filename: String,
    time: Option<String>,
    tags: Vec<String>,
    preview: String,
}

#[derive(Serialize, schemars::JsonSchema)]
struct NoteOutput {
    content: String,
}

#[derive(Serialize, schemars::JsonSchema)]
struct SearchOutput {
    hits: Vec<SearchHitInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct SearchHitInfo {
    /// Which store the hit came from: `timeline` or `note`.
    kind: String,
    title: String,
    snippet: String,
    date: String,
    /// Set for note hits; the argument to pass to `read_note`.
    filename: Option<String>,
    /// Set for timeline hits; the entry's position within its day.
    index: Option<usize>,
    tags: Vec<String>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct TimelineDatesOutput {
    dates: Vec<String>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct TimelineOutput {
    entries: Vec<String>,
}

fn note_to_info(n: magical_merchant_core::NoteSummary) -> NoteInfo {
    NoteInfo {
        filename: n.filename,
        time: n.time.map(|t| t.to_rfc3339()),
        tags: n.tags,
        preview: n.preview,
    }
}

fn hit_to_info(h: magical_merchant_core::SearchHit) -> SearchHitInfo {
    let kind = match h.kind {
        magical_merchant_core::HitKind::Timeline => "timeline",
        magical_merchant_core::HitKind::Note => "note",
    };
    SearchHitInfo {
        kind: kind.to_string(),
        title: h.title,
        snippet: h.snippet,
        date: h.date,
        filename: h.filename,
        index: h.index,
        tags: h.tags,
    }
}

#[tool_router]
impl McpServer {
    #[tool(
        name = "list_notes",
        description = "List all notes, newest first, with their tags and a short preview"
    )]
    fn list_notes(&self) -> Result<Json<NoteListOutput>, String> {
        let notes = magical_merchant_core::list_notes(&self.data_dir).map_err(|e| e.to_string())?;
        Ok(Json(NoteListOutput {
            notes: notes.into_iter().map(note_to_info).collect(),
        }))
    }

    #[tool(
        name = "read_note",
        description = "Read the full Markdown source of a note by its filename"
    )]
    fn read_note(
        &self,
        Parameters(param): Parameters<FilenameParam>,
    ) -> Result<Json<NoteOutput>, String> {
        let filename = magical_merchant_core::NoteFilename::parse(&param.filename)
            .map_err(|e| e.to_string())?;
        let content = magical_merchant_core::read_note_by_filename(&self.data_dir, &filename)
            .map_err(|e| e.to_string())?;
        Ok(Json(NoteOutput { content }))
    }

    #[tool(
        name = "search",
        description = "Search notes and timeline entries for a substring, ignoring case"
    )]
    fn search(
        &self,
        Parameters(param): Parameters<QueryParam>,
    ) -> Result<Json<SearchOutput>, String> {
        let hits = magical_merchant_core::search_all(&self.data_dir, &param.query)
            .map_err(|e| e.to_string())?;
        Ok(Json(SearchOutput {
            hits: hits.into_iter().map(hit_to_info).collect(),
        }))
    }

    #[tool(
        name = "list_timeline_dates",
        description = "List the dates (YYYY-MM-DD) that have timeline entries, newest first"
    )]
    fn list_timeline_dates(&self) -> Result<Json<TimelineDatesOutput>, String> {
        let dates = magical_merchant_core::list_timeline_dates(&self.data_dir)
            .map_err(|e| e.to_string())?;
        Ok(Json(TimelineDatesOutput {
            dates: dates
                .iter()
                .map(|d| d.format("%Y-%m-%d").to_string())
                .collect(),
        }))
    }

    #[tool(
        name = "read_timeline",
        description = "Read all timeline entries for a single day (YYYY-MM-DD)"
    )]
    fn read_timeline(
        &self,
        Parameters(param): Parameters<DateParam>,
    ) -> Result<Json<TimelineOutput>, String> {
        let date = NaiveDate::parse_from_str(&param.date, "%Y-%m-%d")
            .map_err(|e| format!("Invalid date '{}': {e}", param.date))?;
        let entries = magical_merchant_core::read_timeline(&self.data_dir, date)
            .map_err(|e| e.to_string())?;
        Ok(Json(TimelineOutput { entries }))
    }
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::default());
        info.server_info.name = "magical-merchant".into();
        info.server_info.version = "0.1.0".into();
        info.instructions = Some("Magical Merchant note and timeline server".into());
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let items = self.tool_router.list_all();
        Ok(ListToolsResult::with_all_items(items))
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let server = McpServer::new(cli.data_dir);
    let transport = rmcp::transport::io::stdio();
    let running = server.serve(transport).await?;
    running.waiting().await?;
    Ok(())
}
