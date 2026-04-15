use std::path::PathBuf;

use chrono::NaiveDate;
use clap::Parser;
use rmcp::handler::server::tool::ToolRouter;
use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::{
    CallToolRequestParams, CallToolResult, ListToolsResult, PaginatedRequestParams,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::{schemars, tool, tool_router, ErrorData, RoleServer, ServerHandler, ServiceExt};
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
struct ProjectSlugParam {
    /// The project slug identifier
    project_slug: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
struct DateRangeParam {
    /// Start date in YYYY-MM-DD format
    start_date: String,
    /// End date in YYYY-MM-DD format
    end_date: String,
}

// --- Output types ---

#[derive(Serialize, schemars::JsonSchema)]
struct ProjectListOutput {
    projects: Vec<ProjectInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct ProjectInfo {
    slug: String,
    name: String,
    description: String,
    active_task_count: usize,
}

#[derive(Serialize, schemars::JsonSchema)]
struct TaskListOutput {
    tasks: Vec<TaskInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct TaskInfo {
    filename: String,
    title: String,
    created: String,
    completed: Option<String>,
    tags: Vec<String>,
    body: String,
}

#[derive(Serialize, schemars::JsonSchema)]
struct ActivityOutput {
    summaries: Vec<ActivityInfo>,
}

#[derive(Serialize, schemars::JsonSchema)]
struct ActivityInfo {
    slug: String,
    name: String,
    completed_tasks: Vec<TaskInfo>,
    active_task_count: usize,
}

fn task_to_info(t: &magical_merchant_core::TaskSummary) -> TaskInfo {
    TaskInfo {
        filename: t.filename.clone(),
        title: t.title.clone(),
        created: t.created.to_rfc3339(),
        completed: t.completed.map(|dt| dt.to_rfc3339()),
        tags: t.tags.clone(),
        body: t.body.clone(),
    }
}

#[tool_router]
impl McpServer {
    #[tool(name = "list_projects", description = "List all projects")]
    fn list_projects(&self) -> Result<Json<ProjectListOutput>, String> {
        let projects =
            magical_merchant_core::list_projects(&self.data_dir).map_err(|e| e.to_string())?;
        Ok(Json(ProjectListOutput {
            projects: projects
                .into_iter()
                .map(|p| ProjectInfo {
                    slug: p.slug,
                    name: p.name,
                    description: p.description,
                    active_task_count: p.active_task_count,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "list_active_tasks",
        description = "List active (in-progress) tasks for a project"
    )]
    fn list_active_tasks(
        &self,
        Parameters(param): Parameters<ProjectSlugParam>,
    ) -> Result<Json<TaskListOutput>, String> {
        let tasks = magical_merchant_core::list_active_tasks(&self.data_dir, &param.project_slug)
            .map_err(|e| e.to_string())?;
        Ok(Json(TaskListOutput {
            tasks: tasks.iter().map(task_to_info).collect(),
        }))
    }

    #[tool(
        name = "list_completed_tasks",
        description = "List completed tasks for a project"
    )]
    fn list_completed_tasks(
        &self,
        Parameters(param): Parameters<ProjectSlugParam>,
    ) -> Result<Json<TaskListOutput>, String> {
        let tasks = magical_merchant_core::list_done_tasks(&self.data_dir, &param.project_slug)
            .map_err(|e| e.to_string())?;
        Ok(Json(TaskListOutput {
            tasks: tasks.iter().map(task_to_info).collect(),
        }))
    }

    #[tool(
        name = "get_task_history",
        description = "Get completed task history across all projects within a date range (YYYY-MM-DD)"
    )]
    fn get_task_history(
        &self,
        Parameters(param): Parameters<DateRangeParam>,
    ) -> Result<Json<ActivityOutput>, String> {
        let start = NaiveDate::parse_from_str(&param.start_date, "%Y-%m-%d")
            .map_err(|e| format!("Invalid start_date '{}': {e}", param.start_date))?;
        let end = NaiveDate::parse_from_str(&param.end_date, "%Y-%m-%d")
            .map_err(|e| format!("Invalid end_date '{}': {e}", param.end_date))?;

        if start > end {
            return Err(format!(
                "start_date ({start}) must not be after end_date ({end})"
            ));
        }

        let summaries =
            magical_merchant_core::get_project_activity_summary(&self.data_dir, start, end)
                .map_err(|e| e.to_string())?;

        Ok(Json(ActivityOutput {
            summaries: summaries
                .into_iter()
                .map(|s| ActivityInfo {
                    slug: s.slug,
                    name: s.name,
                    completed_tasks: s.completed_tasks.iter().map(task_to_info).collect(),
                    active_task_count: s.active_task_count,
                })
                .collect(),
        }))
    }
}

impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = ServerInfo::new(ServerCapabilities::default());
        info.server_info.name = "magical-merchant".into();
        info.server_info.version = "0.1.0".into();
        info.instructions = Some("Magical Merchant project and task management server".into());
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
    ) -> Result<CallToolResult, ErrorData> {
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let server = McpServer::new(cli.data_dir);
    let transport = rmcp::transport::io::stdio();
    let _server = server.serve(transport).await?;
    _server.waiting().await?;
    Ok(())
}
