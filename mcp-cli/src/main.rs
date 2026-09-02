// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod output;
mod server;

use std::path::PathBuf;

use clap::Parser;
use rmcp::ServiceExt;

/// Tauri の `app_data_dir` と同じ場所。アプリの識別子を変えたらここも変わる。
const APP_IDENTIFIER: &str = "com.magical-merchant.app";

#[derive(Parser)]
#[command(
    name = "magical-merchant-mcp",
    version,
    about = "Read-only MCP server for a Magical Merchant journal"
)]
struct Cli {
    /// Where the app keeps its data. Defaults to the app's own data
    /// directory on this machine.
    #[arg(long, env = "MAGICAL_MERCHANT_DATA_DIR")]
    data_dir: Option<PathBuf>,

    /// Preferred language for place names (`ja` or `en`). Falls back to
    /// whatever language the app has resolved a place in.
    #[arg(long, env = "MAGICAL_MERCHANT_LOCALE", default_value = "en")]
    locale: String,
}

/// アプリが書いている場所を、引数なしでも見つける。公開アプリの MCP に
/// パスを手で書かせると、最初の設定でつまずく。
fn default_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let data_dir = cli
        .data_dir
        .or_else(default_data_dir)
        .ok_or_else(|| anyhow::anyhow!("no data directory: pass --data-dir"))?;
    server::exists_or_hint(&data_dir).map_err(|e| anyhow::anyhow!(e))?;

    let server = server::McpServer::new(data_dir, cli.locale);
    let transport = rmcp::transport::io::stdio();
    let running = server.serve(transport).await?;
    running.waiting().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_data_dir_is_the_apps_own() {
        let dir = default_data_dir().unwrap();

        assert!(dir.ends_with(APP_IDENTIFIER));
    }
}
