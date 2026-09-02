//! `$VISUAL` / `$EDITOR` でファイルを開く。
//!
//! vim モードをアプリに載せる代わりに、本人のエディタをそのまま使わせる。
//! どのエディタかはこちらの関心ではなく、終わるまで待てればいい。

use std::path::Path;
use std::process::Command;

/// 環境変数からエディタのコマンドを組む。`code --wait` のように引数付きで
/// 設定されていることがあるので、空白で分ける。
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

/// エディタが終わるまで待つ。終了コードが 0 以外なら、その編集は
/// 信用しない — 保存せず閉じたのか落ちたのか区別がつかない。
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
