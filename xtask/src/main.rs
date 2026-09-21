//! リポジトリの雑用。シェル 1 行では済まないものだけがここに来る。
//!
//! 出荷物ではない。ワークスペースの一員だが、誰の依存でもなく
//! (`nix/*.nix` は `-p` で名指しして建てる)、配るバイナリにも入らない。
//!
//! いまあるのはサンドボックスの用意だけ。justfile に書かなかったのは、
//! 端末ごとのデータの置き場も、アプリの識別子も、既に Rust 側に答えが
//! あるから — `uname` で書き直すと 3 つ目の答えが増える。

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "xtask", about = "Repository chores")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// The data directory `just sandbox` runs the app against
    Sandbox {
        #[command(subcommand)]
        command: SandboxCommand,
    },
}

#[derive(Subcommand)]
enum SandboxCommand {
    /// Print where the sandbox lives
    Path,
    /// Fill the sandbox from `fixtures/`, replacing what is there
    Seed {
        /// Add the templates from this machine's own data directory
        #[arg(long)]
        mine: bool,
    },
    /// Fill it only if there is no sandbox yet
    Ensure,
    /// Throw the sandbox away
    Reset,
}

fn main() -> Result<()> {
    let repo = repo_root();
    match Cli::parse().command {
        Command::Sandbox { command } => match command {
            SandboxCommand::Path => {
                println!("{}", sandbox_dir(&repo).display());
                Ok(())
            }
            SandboxCommand::Seed { mine } => seed(&repo, mine),
            SandboxCommand::Ensure => ensure(&repo),
            SandboxCommand::Reset => reset(&repo),
        },
    }
}

/// `xtask/` の親。ワークスペースの根で、`fixtures/` も `.sandbox/` もここから。
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn sandbox_dir(repo: &Path) -> PathBuf {
    repo.join(".sandbox")
}

/// 箱が既にあるか。symlink は「ある」とも答えず、その場で断る。
///
/// `exists()` はリンクを辿るので、`.sandbox` が本番のデータディレクトリを
/// 指していると「もう用意されている」と読めてしまう。そのまま
/// `MAGICAL_MERCHANT_DATA_DIR` に据えれば、サンドボックスのつもりで本番の
/// 記録を読み書きすることになる。
fn is_prepared(sandbox: &Path) -> Result<bool> {
    match fs::symlink_metadata(sandbox) {
        Ok(meta) if meta.file_type().is_symlink() => bail!(
            "{} is a symlink. The sandbox has to be a real directory — remove it and run again",
            sandbox.display()
        ),
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err).with_context(|| format!("reading {}", sandbox.display())),
    }
}

/// 見本を写して、書き換えてよいデータディレクトリを作る。中身があっても
/// 作り直す — 見本の姿に戻すのがこの命令の仕事。
fn seed(repo: &Path, mine: bool) -> Result<()> {
    let fixtures = repo.join("fixtures").join("data");
    if !fixtures.is_dir() {
        bail!("no fixtures at {}", fixtures.display());
    }
    let sandbox = sandbox_dir(repo);

    if is_prepared(&sandbox)? {
        fs::remove_dir_all(&sandbox).with_context(|| format!("clearing {}", sandbox.display()))?;
    }
    fs::create_dir_all(&sandbox)?;

    let mut options = fs_extra::dir::CopyOptions::new();
    options.copy_inside = true;
    fs_extra::dir::copy(&fixtures, sandbox.join("data"), &options)
        .with_context(|| format!("copying {}", fixtures.display()))?;
    println!("seeded {} from fixtures/", sandbox.display());

    if mine {
        copy_my_templates(repo, &sandbox)?;
    }
    Ok(())
}

/// 起動のたびに呼ばれる側。既にある箱は触らない — 試している最中に
/// アプリを建て直すたび、書き込んだものが消えては調べ物にならない。
fn ensure(repo: &Path) -> Result<()> {
    if is_prepared(&sandbox_dir(repo))? {
        return Ok(());
    }
    seed(repo, false)
}

/// 箱を捨てる。symlink はリンクだけ消す — 指されている先は誰かの本物で、
/// この命令が消してよいものではない。
fn reset(repo: &Path) -> Result<()> {
    let sandbox = sandbox_dir(repo);
    let link = fs::symlink_metadata(&sandbox).is_ok_and(|meta| meta.file_type().is_symlink());
    if link {
        fs::remove_file(&sandbox)?;
        println!("removed the symlink at {}", sandbox.display());
    } else if sandbox.exists() {
        fs::remove_dir_all(&sandbox)?;
        println!("removed {}", sandbox.display());
    }
    Ok(())
}

/// この端末のテンプレを箱に足す。読むだけで、本番には何も書かない。
///
/// ノートは写さない。テンプレは「どう書くか」の型で、ノートは書いたものその
/// もの — 見本の代わりに自分の記録を並べたいなら、それは本番のアプリを開く
/// ということ。
fn copy_my_templates(repo: &Path, sandbox: &Path) -> Result<()> {
    let Some(mine) = my_data_dir(repo)? else {
        println!("no data directory on this machine — seeded the samples only");
        return Ok(());
    };
    let from = mine.join("data").join("templates");
    if !from.is_dir() {
        println!(
            "no templates at {} — seeded the samples only",
            from.display()
        );
        return Ok(());
    }

    let to = sandbox.join("data").join("templates");
    fs::create_dir_all(&to)?;
    let mut copied = 0;
    for entry in fs::read_dir(&from)? {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "md") {
            let Some(name) = path.file_name() else {
                continue;
            };
            fs::copy(&path, to.join(name))?;
            copied += 1;
        }
    }
    println!("copied {copied} templates from {}", from.display());
    Ok(())
}

/// アプリがこの端末で書いている場所。CLI の `default_data_dir` と同じ解決で、
/// 識別子だけは `tauri.conf.json` から読む — そこが唯一の出どころ。
fn my_data_dir(repo: &Path) -> Result<Option<PathBuf>> {
    let conf = repo
        .join("tauri-app")
        .join("src-tauri")
        .join("tauri.conf.json");
    let text = fs::read_to_string(&conf).with_context(|| format!("reading {}", conf.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)?;
    let identifier = value
        .get("identifier")
        .and_then(serde_json::Value::as_str)
        .context("tauri.conf.json has no identifier")?;

    Ok(dirs::data_dir().map(|dir| dir.join(identifier)))
}
