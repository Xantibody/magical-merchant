// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

mod commands;
mod editor;
mod notes;
mod output;
mod scrawl;
mod server;
mod sync;

use std::io::{IsTerminal, Read as _, Write as _};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use rmcp::ServiceExt;

/// The same place as Tauri's `app_data_dir`. Change the app identifier and this changes too.
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
    ///
    /// `show` falls back to the newest when omitted, but `edit` does not. A mistyped
    /// argument alone would open the latest note in the editor, and how it is closed
    /// decides whether it is written back
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
    /// Take in a note written elsewhere, keeping the time it was written
    ///
    /// The body is read from stdin; the filename it gets — the note's
    /// permanent ID — is printed, so a migration script can record where
    /// each of its files landed.
    Import {
        /// When the note was written, RFC 3339 (`2019-05-04T12:00:00+09:00`).
        /// This becomes the note's filename, so pass the offset it was
        /// written in rather than letting this machine's timezone decide.
        #[arg(long)]
        time: chrono::DateTime<chrono::FixedOffset>,
        /// A tag to record in the frontmatter, without the `#`. Repeat for more.
        #[arg(long = "tag")]
        tags: Vec<String>,
        /// The template the note came from, recorded as `template:`
        #[arg(long)]
        template: Option<String>,
    },
    /// Send and receive notes through the sync server, without opening the app
    ///
    /// Set the server up and log in from the app's Settings first; this reads
    /// the URL and the saved login. Progress is printed per round.
    Sync,
    /// Read the Scrawl or append to today's
    #[command(subcommand)]
    Scrawl(ScrawlCommand),
    /// Serve the journal to an AI client over MCP (stdio)
    Mcp {
        /// Preferred language for place names (`ja` or `en`). Falls back to
        /// whatever language the app has resolved a place in.
        #[arg(long, env = "MAGICAL_MERCHANT_LOCALE", default_value = "en")]
        locale: String,

        /// Also offer the write tools (`create_note`, `update_note`, `restore_note`
        /// and the rest). Every overwrite saves a copy first under `<data-dir>/history`.
        #[arg(long, env = "MAGICAL_MERCHANT_ALLOW_WRITE")]
        allow_write: bool,
    },
}

#[derive(Subcommand)]
enum ScrawlCommand {
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

/// Finds where the app writes even with no argument. Making a user type the path by hand
/// into the public app's MCP trips them up at the first setup.
fn default_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(APP_IDENTIFIER))
}

/// A reader closing first, as in `list | head`, is a normal way to end.
/// `println!` panics, so the write failure is caught here.
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
    // `data/timeline/` from before the rename. Unless this runs before any read, both the
    // listing and the sync walk straight past the old directory
    let _ = magical_merchant_core::migrate_scrawl_dir(&data_dir);

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
            // The group requires one of the two, so no note means --last
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
        Command::Import {
            time,
            tags,
            template,
        } => {
            // Unlike `new`, this never falls back to the editor. An import is a path that
            // pipes hundreds of notes in a row, where an editor opening is only an accident
            if std::io::stdin().is_terminal() {
                anyhow::bail!("import reads the note body from stdin; pipe it in");
            }
            let mut body = String::new();
            std::io::stdin().read_to_string(&mut body)?;
            let created = commands::import(&data_dir, time, &body, &tags, template.as_deref())?;
            // Letting an empty pass as "created nothing" keeps the side piping notes in
            // from noticing that one was dropped. With no name to print, return a failure
            let filename =
                created.ok_or_else(|| anyhow::anyhow!("nothing on stdin, no note created"))?;
            println!("{filename}");
        }
        Command::Sync => sync::run(&data_dir).await?,
        Command::Scrawl(command) => run_scrawl(&data_dir, command)?,
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

fn run_scrawl(data_dir: &Path, command: ScrawlCommand) -> anyhow::Result<()> {
    match command {
        ScrawlCommand::Add { message } => {
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
            let added = text.is_some_and(|t| scrawl::add(data_dir, &t).is_ok_and(|a| a));
            if added {
                eprintln!("added to today's scrawl");
            } else {
                eprintln!("nothing written, no entry added");
            }
        }
        ScrawlCommand::Show { date } => {
            let date = scrawl::resolve_date(date.as_deref())?;
            let mut out = std::io::stdout().lock();
            for entry in scrawl::show(data_dir, date)? {
                let time = entry
                    .time
                    .map_or_else(|| "--:--".to_string(), |t| t.format("%H:%M").to_string());
                // For a multi-line entry, indent the lines after the first by the width of
                // the time so it is clear which entry they continue
                let text = entry.text.replace('\n', "\n       ");
                quiet_on_closed_pipe(writeln!(out, "{time}  {text}"))?;
            }
        }
        ScrawlCommand::Dates => {
            let mut out = std::io::stdout().lock();
            for date in scrawl::dates(data_dir)? {
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

    /// A bare launch does not become an MCP server waiting on stdin. Only `mcp` does that.
    #[test]
    fn running_without_a_subcommand_is_an_error_not_a_server() {
        use clap::CommandFactory as _;

        assert!(Cli::try_parse_from(["magical-merchant"]).is_err());
        assert!(Cli::try_parse_from(["magical-merchant", "mcp", "--allow-write"]).is_ok());
        Cli::command().debug_assert();
    }

    /// An import needs a time. Filename = creation time = ID, so if the time could be
    /// omitted the note would be named "now" and the original date would never come back.
    /// A time that cannot be read is refused right there: noticing after 529 notes have
    /// been piped through is too late.
    #[test]
    fn import_needs_a_time_it_can_read() {
        let parse = |args: &[&str]| Cli::try_parse_from(args);

        assert!(parse(&["magical-merchant", "import"]).is_err());
        assert!(parse(&["magical-merchant", "import", "--time", "昨日"]).is_err());
        assert!(parse(&["magical-merchant", "import", "--time", "2019-05-04"]).is_err());
        assert!(
            parse(&[
                "magical-merchant",
                "import",
                "--time",
                "2019-05-04T12:00:00+09:00",
                "--tag",
                "memo",
                "--tag",
                "work",
                "--template",
                "journal",
            ])
            .is_ok()
        );
    }

    /// `edit` alone does not fall back to the newest when omitted. It is the side that
    /// writes back, so which note it is has to be named every time.
    #[test]
    fn edit_needs_a_note_or_an_explicit_last() {
        assert!(Cli::try_parse_from(["magical-merchant", "edit"]).is_err());
        assert!(Cli::try_parse_from(["magical-merchant", "edit", "--last"]).is_ok());
        assert!(Cli::try_parse_from(["magical-merchant", "edit", "20260320_143045"]).is_ok());
        assert!(Cli::try_parse_from(["magical-merchant", "edit", "x", "--last"]).is_err());
        // show only reads, so it may be omitted
        assert!(Cli::try_parse_from(["magical-merchant", "show"]).is_ok());
    }
}
