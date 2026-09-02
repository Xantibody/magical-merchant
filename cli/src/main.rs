// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod commands;
mod editor;
mod notes;
mod output;
mod server;
mod timeline;

use std::io::{IsTerminal, Read as _, Write as _};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use rmcp::ServiceExt;

/// Tauri の `app_data_dir` と同じ場所。アプリの識別子を変えたらここも変わる。
const APP_IDENTIFIER: &str = "com.magical-merchant.app";

#[derive(Parser)]
#[command(
    name = "magical-merchant",
    version,
    about = "Read, edit and serve a Magical Merchant journal from the terminal"
)]
struct Cli {
    /// Where the app keeps its data. Defaults to the app's own data
    /// directory on this machine.
    #[arg(long, global = true, env = "MAGICAL_MERCHANT_DATA_DIR")]
    data_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List notes, newest first
    List,
    /// Print a note's Markdown body
    Show {
        /// Note filename or stem (`20260320_143045`); the newest note if omitted
        note: Option<String>,
    },
    /// Open a note's body in $VISUAL / $EDITOR and write it back
    /// `show` は省略で最新に倒すが、`edit` は倒さない。引数を打ち損ねた
    /// だけで直近のノートがエディタで開き、閉じ方次第で書き戻される
    #[command(group = clap::ArgGroup::new("target").required(true).args(["note", "last"]))]
    Edit {
        /// Note filename or stem (`20260320_143045`)
        note: Option<String>,
        /// Edit the newest note instead of naming one
        #[arg(long)]
        last: bool,
    },
    /// Create a note: from stdin when piped, otherwise in $VISUAL / $EDITOR
    New {
        /// Title to start the note with
        #[arg(long)]
        title: Option<String>,
    },
    /// Read the Timeline or append to today's
    #[command(subcommand)]
    Timeline(TimelineCommand),
    /// Serve the journal to an AI client over MCP (stdio)
    Mcp {
        /// Preferred language for place names (`ja` or `en`). Falls back to
        /// whatever language the app has resolved a place in.
        #[arg(long, env = "MAGICAL_MERCHANT_LOCALE", default_value = "en")]
        locale: String,

        /// Also offer the write tools (`create_note`, `update_note`, `restore_note`,
        /// ...). Every overwrite saves a copy first under `<data-dir>/history`.
        #[arg(long, env = "MAGICAL_MERCHANT_ALLOW_WRITE")]
        allow_write: bool,
    },
}

#[derive(Subcommand)]
enum TimelineCommand {
    /// Append an entry to today: -m for a one-liner, stdin when piped,
    /// otherwise $VISUAL / $EDITOR
    Add {
        /// The entry text, like `git commit -m`
        #[arg(short, long)]
        message: Option<String>,
    },
    /// Print one day's entries
    Show {
        /// Day to read, `YYYY-MM-DD`; today if omitted
        date: Option<String>,
    },
    /// List the days that have entries, newest first
    Dates,
}

/// アプリが書いている場所を、引数なしでも見つける。公開アプリの MCP に
/// パスを手で書かせると、最初の設定でつまずく。
fn default_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

/// `list | head` のように読み手が先に閉じるのは正常な終わり方。
/// `println!` は panic するので、書き込みの失敗をここで受ける。
fn quiet_on_closed_pipe(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let data_dir = cli
        .data_dir
        .or_else(default_data_dir)
        .ok_or_else(|| anyhow::anyhow!("no data directory: pass --data-dir"))?;
    server::exists_or_hint(&data_dir).map_err(|e| anyhow::anyhow!(e))?;

    match cli.command {
        Command::List => {
            let mut out = std::io::stdout().lock();
            for row in commands::list(&data_dir)? {
                let tags: Vec<String> = row.tags.iter().map(|t| format!("#{t}")).collect();
                quiet_on_closed_pipe(writeln!(
                    out,
                    "{}  {}  {}  {}",
                    row.filename.trim_end_matches(".md"),
                    row.time,
                    row.title,
                    tags.join(" ")
                ))?;
            }
        }
        Command::Show { note } => {
            let filename = commands::resolve(&data_dir, note.as_deref())?;
            let body = commands::show(&data_dir, &filename)?;
            quiet_on_closed_pipe(write!(std::io::stdout().lock(), "{body}"))?;
        }
        Command::Edit { note, last: _ } => {
            // グループが「どちらか必須」なので、note が無ければ --last
            let filename = commands::resolve(&data_dir, note.as_deref())?;
            let editor = editor::command_from_env();
            let outcome = commands::edit(&data_dir, &filename, &commands::scratch_dir(), |path| {
                editor::open(&editor, path)
            })?;
            match outcome {
                commands::EditOutcome::Unchanged => eprintln!("{filename}: unchanged"),
                commands::EditOutcome::Saved { snapshot_id } => {
                    eprintln!("{filename}: saved (previous version kept as {snapshot_id})");
                }
            }
        }
        Command::New { title } => {
            let seed = title.map(|t| format!("# {t}\n\n")).unwrap_or_default();
            let created = if std::io::stdin().is_terminal() {
                let editor = editor::command_from_env();
                commands::compose(&data_dir, &commands::scratch_dir(), &seed, |path| {
                    editor::open(&editor, path)
                })?
            } else {
                let mut body = seed;
                std::io::stdin().read_to_string(&mut body)?;
                commands::create(&data_dir, &body)?
            };
            match created {
                Some(filename) => println!("{filename}"),
                None => eprintln!("nothing written, no note created"),
            }
        }
        Command::Timeline(command) => run_timeline(&data_dir, command)?,
        Command::Mcp {
            locale,
            allow_write,
        } => {
            let server = server::McpServer::new(data_dir, locale, allow_write);
            let transport = rmcp::transport::io::stdio();
            let running = server.serve(transport).await?;
            running.waiting().await?;
        }
    }
    Ok(())
}

fn run_timeline(data_dir: &Path, command: TimelineCommand) -> anyhow::Result<()> {
    match command {
        TimelineCommand::Add { message } => {
            let text = match message {
                Some(text) => Some(text),
                None if std::io::stdin().is_terminal() => {
                    let editor = editor::command_from_env();
                    commands::write_in_editor(&commands::scratch_dir(), "entry", "", |path| {
                        editor::open(&editor, path)
                    })?
                }
                None => {
                    let mut text = String::new();
                    std::io::stdin().read_to_string(&mut text)?;
                    Some(text)
                }
            };
            let added = text.is_some_and(|t| timeline::add(data_dir, &t).is_ok_and(|a| a));
            if added {
                eprintln!("added to today's timeline");
            } else {
                eprintln!("nothing written, no entry added");
            }
        }
        TimelineCommand::Show { date } => {
            let date = timeline::resolve_date(date.as_deref())?;
            let mut out = std::io::stdout().lock();
            for entry in timeline::show(data_dir, date)? {
                let time = entry
                    .time
                    .map_or_else(|| "--:--".to_string(), |t| t.format("%H:%M").to_string());
                // 複数行のエントリは 2 行目以降を時刻の幅ぶん下げて、どの
                // エントリの続きかが見えるようにする
                let text = entry.text.replace('\n', "\n       ");
                quiet_on_closed_pipe(writeln!(out, "{time}  {text}"))?;
            }
        }
        TimelineCommand::Dates => {
            let mut out = std::io::stdout().lock();
            for date in timeline::dates(data_dir)? {
                quiet_on_closed_pipe(writeln!(out, "{date}"))?;
            }
        }
    }
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

    /// 素で起動して stdin を待つ MCP サーバーにならない。`mcp` と書いたときだけ。
    #[test]
    fn running_without_a_subcommand_is_an_error_not_a_server() {
        use clap::CommandFactory as _;

        assert!(Cli::try_parse_from(["magical-merchant"]).is_err());
        assert!(Cli::try_parse_from(["magical-merchant", "mcp", "--allow-write"]).is_ok());
        Cli::command().debug_assert();
    }

    /// `edit` だけは省略で最新に倒さない。書き戻しが起きる側なので、
    /// どのノートかは毎回言わせる。
    #[test]
    fn edit_needs_a_note_or_an_explicit_last() {
        assert!(Cli::try_parse_from(["magical-merchant", "edit"]).is_err());
        assert!(Cli::try_parse_from(["magical-merchant", "edit", "--last"]).is_ok());
        assert!(Cli::try_parse_from(["magical-merchant", "edit", "20260320_143045"]).is_ok());
        assert!(Cli::try_parse_from(["magical-merchant", "edit", "x", "--last"]).is_err());
        // show は読むだけなので省略でよい
        assert!(Cli::try_parse_from(["magical-merchant", "show"]).is_ok());
    }
}
