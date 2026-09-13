//! `magical-merchant sync` — アプリを開かずに Workers/R2 と同期する。
//!
//! 同期そのものは core のエンジン 1 本(`engine::run_with_progress`)で、
//! ここがやるのは設定とトークンを解くことと、進み具合を行にすること。
//! ログインは今もアプリの仕事: CLI は保管された JWT を読むだけで、
//! 期限が切れていたらアプリに戻すよう言う。

use std::path::Path;

use magical_merchant_core::sync::client::{HttpClient, desktop_http_client};
use magical_merchant_core::sync::config::SyncConfig;
use magical_merchant_core::sync::engine::{self, RoundProgress};
use magical_merchant_core::sync::token;
use magical_merchant_core::sync::{SyncError, SyncResult};

#[derive(Debug)]
pub(crate) struct Credentials {
    pub(crate) workers_url: String,
    pub(crate) token: String,
}

/// 設定とトークンを解く。順番と `kind` はアプリの `do_sync` に合わせる —
/// 同じ状態に別の名前が付くと、片方だけ直したときに気づけない。
///
/// トークンの読み手を引数に取るのは、Keychain を開かずに試すため。
pub(crate) fn credentials<F>(base_dir: &Path, read_token: F) -> Result<Credentials, SyncError>
where
    F: Fn(&Path) -> Result<Option<String>, String>,
{
    let config = SyncConfig::load(base_dir)?.unwrap_or_default();
    if !config.is_configured() {
        return Err(SyncError::new(
            "notConfigured",
            "Sync is not set up. Add your Workers URL in the app's Settings.",
        ));
    }
    let token = read_token(base_dir)
        .map_err(SyncError::other)?
        .ok_or_else(|| {
            SyncError::new(
                "notAuthenticated",
                "Not logged in. Log in from the app's Settings.",
            )
        })?;
    if !token::is_token_valid(&token) {
        return Err(SyncError::new(
            "notAuthenticated",
            "Login expired. Log in again from the app's Settings.",
        ));
    }
    Ok(Credentials {
        workers_url: config.workers_url,
        token,
    })
}

/// round が 1 つ終わるたびの 1 行。529 本の取り込みは 14 往復するので、
/// 何も出ないと固まったようにしか見えない。
fn round_line(progress: &RoundProgress) -> String {
    format!(
        "round {}  {} done, {} left",
        progress.round, progress.done, progress.remaining
    )
}

/// 終わったあとの 1 行。記号はアプリの表示と同じものを使う。
///
/// 0 の項も省かずに出す。取り込みの直後に「送ったはずの本数」を突き合わせる
/// のが最初の使い道で、そこで省かれると数えられない。
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

/// 走査より前に、アプリが一覧と同期の前に必ず通しているのと同じ修復を
/// かける。
///
/// 古い版は競合コピーを `data/` の中に置いていた。それを抱えたまま同期に
/// 入ると、走査がただのノートとして拾い、残骸が全端末へ配られる。これまで
/// 同期を始めるのはアプリだけで、アプリは `repair_once` を必ず通っていた。
/// CLI から始められるようになった以上、同じ関門をこちらにも置く。
fn repair(data_dir: &Path) {
    // 直せなくても同期はできる。直せなかったことを理由に止めるほうが損
    let _ = magical_merchant_core::repair_notes(data_dir);
    let _ = magical_merchant_core::relocate_conflict_copies(data_dir);
}

/// エンジンに入る前に済ませること。修復と資格情報の解決を 1 つにまとめて
/// あるのは、どちらか片方だけを通る道を作らないため — 修復を飛ばした同期は
/// 古い競合コピーを全端末に配る。
fn prepare<F>(data_dir: &Path, read_token: F) -> Result<Credentials, SyncError>
where
    F: Fn(&Path) -> Result<Option<String>, String>,
{
    repair(data_dir);
    credentials(data_dir, read_token)
}

pub(crate) async fn run(data_dir: &Path) -> anyhow::Result<()> {
    let credentials = prepare(data_dir, token::get_token)?;
    let client = HttpClient::new(
        desktop_http_client()?,
        &credentials.workers_url,
        &credentials.token,
    );

    let result = engine::run_with_progress(&client, data_dir, |progress| {
        eprintln!("{}", round_line(&progress));
    })
    .await
    .map_err(|e| describe_failure(&e))?;

    println!("{}", summary(&result));
    // 1 本でも取りこぼしたなら成功では終わらせない。取り込みの検算は
    // 終了コードで見るので、本数が合わないまま 0 を返しては困る
    if !result.errors.is_empty() {
        for issue in &result.errors {
            eprintln!("{issue}");
        }
        anyhow::bail!("{} file(s) could not be synced", result.errors.len());
    }
    Ok(())
}

/// エンジンの失敗を、CLI から見た言葉にする。`busy` だけはアプリの UI と
/// 逆で、黙って成功に倒さない — 待てば済むことを伝えて終わる。
fn describe_failure(err: &SyncError) -> anyhow::Error {
    if err.kind == "busy" {
        return anyhow::anyhow!("the app is syncing right now; wait for it to finish");
    }
    anyhow::anyhow!("{}", err.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use tempfile::TempDir;

    fn configured() -> TempDir {
        let dir = TempDir::new().unwrap();
        SyncConfig {
            workers_url: "https://example.workers.dev".to_string(),
            auto_sync: false,
        }
        .save(dir.path())
        .unwrap();
        dir
    }

    /// 署名は誰も見ない。`is_token_valid` が読むのは `exp` だけなので、
    /// 3 つのパートを直に組む(`core/src/sync/token.rs` のテストと同じ手)。
    fn jwt(exp: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    #[allow(clippy::unnecessary_wraps, reason = "credentials が求める読み手の形")]
    fn no_token(_: &Path) -> Result<Option<String>, String> {
        Ok(None)
    }

    /// 古い版が `data/` に残した競合コピーを、走査より前に外へ出す。
    /// 残っていると走査がただのノートとして拾い、同期が残骸を全端末へ配る。
    /// これまでこの関門を通っていたのはアプリだけだった。
    ///
    /// `repair` ではなく `prepare` を呼ぶ: 確かめたいのは修復が動くことでは
    /// なく、エンジンへ向かう道が必ず修復を通ること。
    #[test]
    fn a_legacy_conflict_copy_is_moved_out_on_the_way_to_the_engine() {
        let dir = configured();
        let notes = dir.path().join("data/notes");
        std::fs::create_dir_all(&notes).unwrap();
        let stale = notes.join("20260320_033440.sync-conflict-20260511-031336.md");
        std::fs::write(&stale, "leftover").unwrap();
        std::fs::write(notes.join("20260320_033440.md"), "the note").unwrap();
        let live = jwt(chrono::Utc::now().timestamp() + 3600);

        prepare(dir.path(), |_| Ok(Some(live.clone()))).unwrap();

        assert!(!stale.exists(), "競合コピーが data/ に残っている");
        assert!(
            notes.join("20260320_033440.md").exists(),
            "本体は動かさない"
        );
    }

    /// 同期の設定はアプリの画面にしかない。CLI に URL を打たせると、
    /// アプリ側の設定と食い違った同期先ができる
    #[test]
    fn without_a_workers_url_it_points_at_the_app() {
        let dir = TempDir::new().unwrap();

        let err = credentials(dir.path(), no_token).unwrap_err();

        assert_eq!(err.kind, "notConfigured");
        assert!(err.message.contains("Settings"), "{}", err.message);
    }

    #[test]
    fn without_a_token_it_asks_for_a_login() {
        let dir = configured();

        let err = credentials(dir.path(), no_token).unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
    }

    /// 期限切れを持ったまま同期に入ると、サーバーに断られてから
    /// 「ログインし直せ」に辿り着く。先に見て、同じ言葉で止める
    #[test]
    fn an_expired_token_is_refused_before_the_network() {
        let dir = configured();
        let expired = jwt(chrono::Utc::now().timestamp() - 100);

        let err = credentials(dir.path(), |_| Ok(Some(expired.clone()))).unwrap_err();

        assert_eq!(err.kind, "notAuthenticated");
        assert!(err.message.contains("expired"), "{}", err.message);
    }

    #[test]
    fn a_live_token_and_a_url_are_what_the_client_needs() {
        let dir = configured();
        let live = jwt(chrono::Utc::now().timestamp() + 3600);

        let ready = credentials(dir.path(), |_| Ok(Some(live.clone()))).unwrap();

        assert_eq!(ready.workers_url, "https://example.workers.dev");
        assert_eq!(ready.token, live);
    }

    /// 取り込みの検算はこの行を数える。0 の項が消えると突き合わせられない
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

    /// 競合は転送の数字に混ぜない。控えが残ったことは別に言う
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

    /// アプリは `busy` を黙って無視するが、CLI は待てば済むと言って終わる。
    /// 何も出さずに 0 を返すと、同期したつもりのまま次へ進んでしまう
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
