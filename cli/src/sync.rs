//! `magical-merchant sync`: syncs with Workers/R2 without opening the app.
//!
//! The syncing itself is one engine in core (`run::run_with_progress`), and so is the
//! login check (`login::sync_client`); what this does is turn progress into lines.
//! Signing in is still the app's job: the CLI only reads the stored JWT (and renews it
//! past half its lifetime, as the app does), and if it has expired it says to go back to
//! the app.

use std::path::Path;

use magical_merchant_core::SyncError;
use magical_merchant_core::domain::sync::SyncResult;
use magical_merchant_core::domain::sync::login;
use magical_merchant_core::domain::sync::run::{RoundProgress, run_with_progress};
use magical_merchant_core::services::worker::desktop_http_client;

/// Where the CLI's refusals send the reader: signing in happens in the app.
const SETTINGS_PLACE: &str = "the app's Settings";

/// One line each time a round finishes. Importing 529 files takes 14 round trips, and
/// with nothing printed it only looks stuck.
fn round_line(progress: &RoundProgress) -> String {
    format!(
        "round {}  {} done, {} left",
        progress.round, progress.done, progress.remaining
    )
}

/// One line once it is over. The symbols are the ones the app displays.
///
/// The zero entries are printed too, not left out. The first use is to check the
/// number of files sent right after an import, and leaving them out makes that
/// impossible to count.
fn summary(result: &SyncResult) -> String {
    let deleted = result.deleted_remote + result.deleted_local;
    if result.uploaded + result.downloaded + deleted + result.conflicts == 0 {
        return "already up to date".to_string();
    }
    let kept = if result.conflicts > 0 {
        format!("  ({} kept as conflict copies)", result.conflicts)
    } else {
        String::new()
    };
    format!(
        "↑{} ↓{} −{deleted}{kept}",
        result.uploaded, result.downloaded
    )
}

pub(crate) async fn run(data_dir: &Path) -> anyhow::Result<()> {
    // The repair that runs before the scan is inside the engine, inside the sync lock.
    // Doing it here first would rewrite the tree while the app is syncing.
    // A renewed login is stored in the Keychain the CLI shares with the app, so it
    // reaches both
    let client = login::sync_client(
        data_dir,
        desktop_http_client,
        SETTINGS_PLACE,
        || login::get_token(data_dir),
        |fresh| login::store_token(data_dir, fresh),
    )
    .await
    .map_err(|e| describe_failure(&e))?;

    let result = run_with_progress(&client, data_dir, |progress| {
        eprintln!("{}", round_line(&progress));
    })
    .await
    .map_err(|e| describe_failure(&e))?;

    println!("{}", summary(&result));
    // Do not end in success if even one file was missed. The import is checked by the
    // exit code, so returning 0 with the counts off is no good
    if !result.errors.is_empty() {
        for issue in &result.errors {
            eprintln!("{issue}");
        }
        anyhow::bail!("{} file(s) could not be synced", result.errors.len());
    }
    Ok(())
}

/// Turns an engine failure into words the CLI can use.
///
/// `busy` is the one case that goes the other way from the app UI. It is not quietly
/// turned into a success: it says that waiting is all it takes, and ends.
fn describe_failure(err: &SyncError) -> anyhow::Error {
    if err.kind == "busy" {
        return anyhow::anyhow!("the app is syncing right now; wait for it to finish");
    }
    anyhow::anyhow!("{}", err.message)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The import is verified by counting this line. If the zero entries vanish there
    /// is nothing to match it against
    #[test]
    fn the_summary_keeps_every_count_even_at_zero() {
        let result = SyncResult {
            uploaded: 529,
            ..SyncResult::default()
        };

        assert_eq!(summary(&result), "↑529 ↓0 −0");
    }

    #[test]
    fn the_summary_says_so_when_there_was_nothing_to_do() {
        assert_eq!(summary(&SyncResult::default()), "already up to date");
    }

    /// Conflicts are not mixed into the transfer counts. That a copy was kept is said
    /// separately
    #[test]
    fn conflicts_are_reported_next_to_the_counts() {
        let result = SyncResult {
            uploaded: 1,
            conflicts: 2,
            ..SyncResult::default()
        };

        assert_eq!(summary(&result), "↑1 ↓0 −0  (2 kept as conflict copies)");
    }

    #[test]
    fn each_round_prints_what_it_did_and_what_is_left() {
        let line = round_line(&RoundProgress {
            round: 3,
            done: 40,
            remaining: 449,
        });

        assert_eq!(line, "round 3  40 done, 449 left");
    }

    /// The app ignores `busy` silently, but the CLI ends by saying that waiting is
    /// enough. Printing nothing and returning 0 would move on as if it had synced
    #[test]
    fn a_busy_app_is_explained_rather_than_ignored() {
        let err = describe_failure(&SyncError::new("busy", "Sync already in progress"));

        assert!(err.to_string().contains("wait"), "{err}");
    }

    #[test]
    fn other_failures_keep_the_engines_own_words() {
        let err = describe_failure(&SyncError::new("stalled", "Sync stopped making progress"));

        assert_eq!(err.to_string(), "Sync stopped making progress");
    }
}
