//! ログインの入口。設定ファイルとトークン保管は core
//! (`magical_merchant_core::sync::{config, token}`) にあり、ここに残るのは
//! アプリ内のログイン窓と、そこから呼ばれる Tauri command だけ。

#[cfg(not(target_os = "android"))]
use std::path::Path;

use magical_merchant_core::sync::SyncError;
use magical_merchant_core::sync::config::{SyncConfig, normalize_workers_url};
#[cfg(not(target_os = "android"))]
use magical_merchant_core::sync::token::store_token;
use magical_merchant_core::sync::token::{clear_token, get_token, is_token_valid};
use tauri::{AppHandle, Manager};
#[cfg(target_os = "android")]
use tauri_plugin_opener::OpenerExt;
#[cfg(not(target_os = "android"))]
use url::Url;

fn build_auth_url(workers_url: &str, app_redirect: &str) -> String {
    format!(
        "{}/auth/google?app_redirect={}",
        workers_url.trim_end_matches('/'),
        urlencoding::encode(app_redirect)
    )
}

/// ログイン画面を出すアプリ内の窓。ラベルは 1 つだけ持ち、二度目からは
/// 同じ窓を次の URL へ送る — `close()` はイベントループ越しなので、閉じた
/// 直後に同じラベルで建て直すと衝突することがある。
#[cfg(not(target_os = "android"))]
const AUTH_WINDOW_LABEL: &str = "auth";

/// ログインをアプリの中で完結させる。外部ブラウザに投げるとアプリが背面へ
/// 回り、承認のあと自分で戻ってこないといけない。認証は始めた場所で終わる。
#[cfg(not(target_os = "android"))]
fn open_auth_window(handle: &AppHandle, auth_url: &str) -> Result<tauri::WebviewWindow, String> {
    let url = Url::parse(auth_url).map_err(|e| format!("Invalid auth URL: {e}"))?;

    if let Some(existing) = handle.get_webview_window(AUTH_WINDOW_LABEL) {
        existing
            .navigate(url)
            .map_err(|e| format!("Failed to open the sign-in window: {e}"))?;
        let _ = existing.set_focus();
        return Ok(existing);
    }

    tauri::WebviewWindowBuilder::new(handle, AUTH_WINDOW_LABEL, tauri::WebviewUrl::External(url))
        .title("Sign in")
        .inner_size(520.0, 700.0)
        .center()
        .build()
        .map_err(|e| format!("Failed to open the sign-in window: {e}"))
}

/// 窓が閉じられたことを一度だけ知らせる受け口。閉じたのに待ち続けると、
/// やめたつもりの利用者を 5 分間のタイムアウトまで待たせることになる。
#[cfg(not(target_os = "android"))]
fn closed_signal(window: &tauri::WebviewWindow) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // on_window_event は Fn を求めるので、一度きりの送信側を包んで取り出す
    let tx = std::sync::Mutex::new(Some(tx));
    window.on_window_event(move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        if let Some(tx) = tx.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(());
        }
    });
    rx
}

/// ブラウザに返す唯一のページ。窓はこのあとアプリが畳むので、案内だけ置く。
#[cfg(not(target_os = "android"))]
const CALLBACK_RESPONSE: &str = concat!(
    "HTTP/1.1 200 OK\r\n",
    "Content-Type: text/html; charset=utf-8\r\n",
    "Connection: close\r\n\r\n",
    "<html><body><p>You can close this window.</p></body></html>"
);

/// 待っている間に来る、コールバックではないリクエストへの返事。
#[cfg(not(target_os = "android"))]
const NOT_FOUND_RESPONSE: &str = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";

/// 生の HTTP リクエストから、保存してよいトークンだけを読む。
///
/// ループバックの口はサインインの間ずっと開いていて、ローカルの誰でも
/// 叩ける。パスの nonce は「この窓から始めたログインの戻りである」ことの
/// 唯一の証で、JWT の期限はその中身が使えることの最低限の確認。
#[cfg(not(target_os = "android"))]
fn callback_token(request_text: &str, callback_path: &str) -> Option<String> {
    let target = request_text.lines().next()?.split_whitespace().nth(1)?;
    // AIDEV-NOTE: 絶対 URL 形式の要求先は捨てる。join がホストごと差し替え、パスだけ一致させられる
    if !target.starts_with('/') {
        return None;
    }
    let url = Url::parse("http://127.0.0.1/").ok()?.join(target).ok()?;
    if url.path() != callback_path {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|token| is_token_valid(token))
}

/// 1 本の接続を抱えていられる時間。ブラウザは繋いだ直後にリクエストを送る
/// ので、これだけあれば本物には足りる。並行に読むぶん、この上限が延びても
/// コールバックの受け付けは遅れない — 遅れるのは黙った接続を畳む時刻だけ。
#[cfg(not(target_os = "android"))]
const CONNECTION_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 繋いできた 1 本を読んで、保存してよいトークンだけを返す。返事は結果に
/// 関わらず書く — 本物には案内を、それ以外には 404 を。
#[cfg(not(target_os = "android"))]
async fn read_callback_token(
    mut stream: tokio::net::TcpStream,
    callback_path: &str,
    read_timeout: std::time::Duration,
) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = vec![0u8; 4096];
    // 繋いだまま何も送ってこない接続をいつまでも抱えない。時間切れも
    // 読み取り失敗も、この 1 本を捨てる理由
    let Ok(Ok(n)) = tokio::time::timeout(read_timeout, stream.read(&mut buf)).await else {
        return None;
    };
    let token = callback_token(&String::from_utf8_lossy(&buf[..n]), callback_path);

    let response = if token.is_some() {
        CALLBACK_RESPONSE
    } else {
        NOT_FOUND_RESPONSE
    };
    let _ = stream.write_all(response.as_bytes()).await;

    token
}

/// nonce の一致したコールバックが来るまで待つ。一致しないものは 404 で
/// 捨てて待ち続ける — 先に繋いだだけの相手にログインを横取りさせない。
///
/// 読むのは並行、受け付けは止めない。ポートは総当たりで見つかるので、
/// ローカルのプロセスは好きな本数だけ繋いでこられる。
///
/// AIDEV-NOTE: 接続は並行に読む。順に読む案は却下 — 黙った接続を 60 本並べるだけで 300 秒の窓を食い潰せた
#[cfg(not(target_os = "android"))]
async fn accept_callback_token(
    listener: &tokio::net::TcpListener,
    callback_path: &str,
    read_timeout: std::time::Duration,
) -> Result<String, String> {
    let mut reading = tokio::task::JoinSet::new();

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted
                    .map_err(|e| format!("Failed to accept connection: {e}"))?;
                let callback_path = callback_path.to_owned();
                reading.spawn(async move {
                    read_callback_token(stream, &callback_path, read_timeout).await
                });
            }
            // 無効だった 1 本は、次を待つ理由にしかならない。空の JoinSet は
            // 即 None を返し、その回はこの枝が外れて accept だけを待つ
            Some(read) = reading.join_next() => {
                if let Ok(Some(token)) = read {
                    return Ok(token);
                }
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
async fn login_with_loopback(
    handle: &AppHandle,
    base_dir: &Path,
    config: &SyncConfig,
) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind loopback: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    // 戻り先はこのログイン 1 回きりのもの。ポートは総当たりで見つかるが、
    // nonce は推測できないので、ここに届いた token だけが自分のものだと言える
    let callback_path = format!("/callback/{}", uuid::Uuid::new_v4());
    let app_redirect = format!("http://127.0.0.1:{port}{callback_path}");
    let auth_url = build_auth_url(&config.workers_url, &app_redirect);

    let window = open_auth_window(handle, &auth_url)?;
    let closed = closed_signal(&window);

    let accepted = tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(300), accept_callback_token(&listener, &callback_path, CONNECTION_READ_TIMEOUT)) => result,
        _ = closed => return Err("Login was cancelled.".to_string()),
    };

    let outcome = accepted
        .map_err(|_| "Login timed out. Please try again.".to_string())
        .and_then(|token| token)
        .and_then(|token| store_token(base_dir, &token))
        // SyncButton などが認証状態を即時反映できるよう通知する
        .inspect(|()| {
            let _ = tauri::Emitter::emit(handle, "auth-success", ());
        });

    // 窓は結果に関わらず畳む。成否は設定画面が伝えるので、たどり着いた
    // コールバックの画面をアプリの手前に残しておく理由がない
    let _ = window.close();

    outcome
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    const CALLBACK_PATH: &str = "/callback/11111111-2222-3333-4444-555555555555";

    /// 署名は誰も見ない (`sync::token::is_token_valid` と同じ理由) ので 3 つのパートを直に組む
    fn jwt(expires_in: i64) -> String {
        let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
        let exp = chrono::Utc::now().timestamp() + expires_in;
        let claims = URL_SAFE_NO_PAD.encode(format!(r#"{{"exp":{exp}}}"#));
        format!("{header}.{claims}.not-a-real-signature")
    }

    fn get(target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
    }

    #[test]
    fn the_token_on_the_callback_path_is_taken() {
        let token = jwt(3600);
        let request = get(&format!("{CALLBACK_PATH}?token={token}"));

        assert_eq!(callback_token(&request, CALLBACK_PATH), Some(token));
    }

    /// nonce を知らない相手が先に繋いでも、待っている側は何も受け取らない。
    /// これを取り違えると、以後の同期が相手のアカウントへ向く
    #[test]
    fn a_token_on_another_path_is_ignored() {
        let request = get(&format!("/callback?token={}", jwt(3600)));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    /// 期限切れを保存すると、生きているトークンを潰したうえで
    /// 次の同期が「ログインし直してください」で止まる
    #[test]
    fn an_expired_token_is_ignored() {
        let request = get(&format!("{CALLBACK_PATH}?token={}", jwt(-100)));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_malformed_token_is_ignored() {
        let request = get(&format!("{CALLBACK_PATH}?token=not-a-jwt"));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_request_without_a_token_is_ignored() {
        assert_eq!(callback_token(&get(CALLBACK_PATH), CALLBACK_PATH), None);
    }

    /// 絶対 URL 形式のリクエスト行はパスだけ一致させられる
    #[test]
    fn an_absolute_request_target_is_ignored() {
        let request = get(&format!(
            "http://evil.example{CALLBACK_PATH}?token={}",
            jwt(3600)
        ));

        assert_eq!(callback_token(&request, CALLBACK_PATH), None);
    }

    #[test]
    fn a_request_that_is_not_http_is_ignored() {
        assert_eq!(callback_token("", CALLBACK_PATH), None);
        assert_eq!(callback_token("garbage", CALLBACK_PATH), None);
    }

    /// ポートは総当たりで見つかる。繋いだきり何も送らないローカルプロセスが
    /// 1 つあるだけでログインが通らなくなると、nonce は守れていても利用者は
    /// 外側の 5 分を待たされる
    #[tokio::test]
    async fn a_silent_connection_does_not_hold_up_the_callback() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // accept の順は繋いだ順。黙っている側が先に取り出される
        let _silent = tokio::net::TcpStream::connect(addr).await.unwrap();

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            accept_callback_token(
                &listener,
                CALLBACK_PATH,
                std::time::Duration::from_millis(50),
            ),
        )
        .await
        .expect("the silent connection must not keep the callback waiting");

        assert_eq!(accepted, Ok(token));
    }

    /// 黙った接続を並べるのは、1 本を無限に居座らせるのと同じ効き目を持つ。
    /// 1 本ずつ順に読むと、読み取りの上限 × 並べた本数だけコールバックの
    /// 受け付けが遅れ、外側の 5 分をまるごと食い潰せる
    #[tokio::test]
    async fn many_silent_connections_do_not_hold_up_the_callback() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // 60 本 × 5 秒 = 300 秒。本物の読み取り上限のまま、外側の窓と同じ長さ
        let mut silent = Vec::new();
        for _ in 0..60 {
            silent.push(tokio::net::TcpStream::connect(addr).await.unwrap());
        }

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            accept_callback_token(&listener, CALLBACK_PATH, CONNECTION_READ_TIMEOUT),
        )
        .await
        .expect("queued silent connections must not delay the callback");

        assert_eq!(accepted, Ok(token));
        // 待っている間ずっと繋がっていないと、並べた意味がない
        drop(silent);
    }

    /// nonce の違うものを先に何本も読んでも、待っている側が拾うのは
    /// 一致した 1 本だけ。並行に読むと「無効だった」が複数返ってくるので、
    /// そのどれかで待つのをやめないことを固定する
    #[tokio::test]
    async fn the_valid_token_wins_over_connections_read_alongside_it() {
        use tokio::io::AsyncWriteExt as _;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let stolen = jwt(3600);
        let mut impostors = Vec::new();
        for _ in 0..10 {
            let mut impostor = tokio::net::TcpStream::connect(addr).await.unwrap();
            impostor
                .write_all(get(&format!("/callback/other?token={stolen}")).as_bytes())
                .await
                .unwrap();
            impostors.push(impostor);
        }

        let token = jwt(3600);
        let mut browser = tokio::net::TcpStream::connect(addr).await.unwrap();
        browser
            .write_all(get(&format!("{CALLBACK_PATH}?token={token}")).as_bytes())
            .await
            .unwrap();

        let accepted = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            accept_callback_token(&listener, CALLBACK_PATH, CONNECTION_READ_TIMEOUT),
        )
        .await
        .expect("a mismatched nonce must not end the wait");

        assert_eq!(accepted, Ok(token));
        drop(impostors);
    }
}

// Tauri commands

#[tauri::command]
pub(crate) async fn auth_login(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = SyncConfig::load(&base_dir)
        .map_err(|e| e.message)?
        .unwrap_or_default();

    if !config.is_configured() {
        return Err("Sync not configured".to_string());
    }

    #[cfg(not(target_os = "android"))]
    {
        login_with_loopback(&handle, &base_dir, &config).await
    }

    #[cfg(target_os = "android")]
    {
        let auth_url = build_auth_url(&config.workers_url, "magical-merchant://auth/callback");
        handle
            .opener()
            .open_url(&auth_url, None::<&str>)
            .map_err(|e| format!("Failed to open browser: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn auth_status(handle: AppHandle) -> Result<bool, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(get_token(&base_dir)?.is_some_and(|token| is_token_valid(&token)))
}

#[tauri::command]
pub(crate) fn auth_logout(handle: AppHandle) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    clear_token(&base_dir)
}

/// 読めなかった設定は `kind: "configCorrupt"` で返す。既定値にすり替えると
/// 設定画面が空欄で開き、入力し直した URL が壊れたファイルを上書きする
#[tauri::command]
pub(crate) fn get_sync_config(handle: AppHandle) -> Result<SyncConfig, SyncError> {
    let base_dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| SyncError::other(e.to_string()))?;
    Ok(SyncConfig::load(&base_dir)?.unwrap_or_default())
}

#[tauri::command]
pub(crate) fn save_sync_config(handle: AppHandle, config: SyncConfig) -> Result<(), String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config = SyncConfig {
        workers_url: normalize_workers_url(&config.workers_url)?,
        auto_sync: config.auto_sync,
    };
    config.save(&base_dir)
}

#[tauri::command]
pub(crate) fn is_sync_config_editable(handle: AppHandle) -> Result<bool, String> {
    let base_dir = handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(SyncConfig::is_editable(&base_dir))
}
