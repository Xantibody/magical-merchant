//! Opens a file with `$VISUAL` / `$EDITOR`.
//!
//! Instead of putting a vim mode in the app, let people use their own editor as
//! it is. Which editor it is does not concern us; waiting for it to exit does.

use std::path::Path;
use std::process::Command;

/// Builds the editor command from the environment variables.
///
/// It splits on whitespace, because the variable can carry arguments, as in
/// `code --wait`.
pub(crate) fn command_from_env() -> Vec<String> {
    let value = std::env::var("VISUAL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("EDITOR").ok())
        .filter(|v| !v.trim().is_empty());
    parse(value.as_deref())
}

fn parse(value: Option<&str>) -> Vec<String> {
    let words: Vec<String> = value
        .unwrap_or("vi")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if words.is_empty() {
        vec!["vi".to_string()]
    } else {
        words
    }
}

/// Waits for the editor to exit.
///
/// A non-zero exit code means the edit is not trusted: there is no way to tell a
/// close without saving from a crash.
pub(crate) fn open(command: &[String], path: &Path) -> Result<(), String> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| "no editor configured; set $EDITOR".to_string())?;
    let status = Command::new(program)
        .args(args)
        .arg(path)
        .status()
        .map_err(|e| format!("could not start {program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_editor_with_arguments_is_split_into_words() {
        assert_eq!(parse(Some("code --wait")), vec!["code", "--wait"]);
    }

    #[test]
    fn nothing_configured_falls_back_to_vi() {
        assert_eq!(parse(None), vec!["vi"]);
        assert_eq!(parse(Some("   ")), vec!["vi"]);
    }

    #[test]
    fn a_failing_editor_is_reported_with_its_status() {
        let err = open(&["false".to_string()], Path::new("/dev/null")).unwrap_err();

        assert!(err.contains("false exited"));
    }
}
