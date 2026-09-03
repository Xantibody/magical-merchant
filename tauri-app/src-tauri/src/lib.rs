// A panicking assertion is the point of a test; only production code has to
// prove it handles the error case.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]
// `#[tauri::command]` arguments arrive by value: serde deserializes them out of
// the IPC payload, and `AppHandle` / `State` are injected owned. Borrowing them
// is not an option this crate has.
#![allow(clippy::needless_pass_by_value)]

#[cfg(target_os = "android")]
mod android_tls;
mod auth;
mod device;
mod export;
#[cfg(target_os = "macos")]
mod location;
mod place;
mod sync;
// Public because it is a real external surface: the JNI symbol inside is what
// the Android widget links against, and `unreachable_pub` is right that a
// private module cannot hold one honestly.
#[cfg(target_os = "android")]
pub mod widget_bridge;
// Only the Android JNI bridge reads this, but it is built everywhere so its
// tests run: CI has no Android target, and the parsing is the part worth
// testing.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
mod widget_summary;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use device::ClientContext;
use magical_merchant_core::{
    CreatedNote, GlyphFormat, GlyphName, GlyphSummary, NoteFilename, NoteMeta, NoteSummary,
    Provenance, Revision, SearchHit, TemplateDetail, TemplateSummary, VarLocale,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt as _;

fn app_base_dir(handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    handle.path().app_data_dir().map_err(|e| e.to_string())
}

fn parse_filename(filename: &str) -> Result<NoteFilename, String> {
    NoteFilename::parse(filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_quick_capture(
    handle: AppHandle,
    text: String,
    client: ClientContext,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let context = device::get_context(client);
    magical_merchant_core::save_timeline_entry(&base_dir, &text, &context)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_draft(
    handle: AppHandle,
    body: String,
    tags: Vec<String>,
    client: ClientContext,
    origin: Option<String>,
) -> Result<String, String> {
    let base_dir = app_base_dir(&handle)?;
    let context = device::get_context(client);
    // origin 付きはタイムラインエントリからの昇格。出自を frontmatter に刻む
    let path = magical_merchant_core::create_draft_note(
        &base_dir,
        &body,
        &tags,
        &context,
        Provenance {
            origin: origin.as_deref(),
            ..Provenance::default()
        },
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// 保存の失敗。`stale` はフロントが「読み直して知らせる」に分岐するための印。
#[derive(Debug, Clone, serde::Serialize)]
struct SaveError {
    kind: &'static str,
    message: String,
}

/// `revision` は `read_note` が返した本文の指紋。添えると、そのあいだに
/// CLI や MCP が同じノートを書き換えていれば `stale` で断られる。
/// 返るのは書いた本文の revision — 次の保存に添える。
#[tauri::command]
fn update_draft(
    file_path: String,
    body: String,
    client: ClientContext,
    revision: Option<String>,
) -> Result<String, SaveError> {
    let context = device::get_context(client);
    let expected = revision.map(Revision::from);
    magical_merchant_core::update_note(
        std::path::Path::new(&file_path),
        &body,
        &context,
        expected.as_ref(),
    )
    .map(|r| r.to_string())
    .map_err(|e| SaveError {
        kind: match e {
            magical_merchant_core::CoreError::Stale(_) => "stale",
            _ => "other",
        },
        message: e.to_string(),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
struct NoteRead {
    body: String,
    /// 本文の指紋。`update_draft` に添えて、外からの書き換えの上に書かない。
    revision: String,
}

#[tauri::command]
fn list_notes(handle: AppHandle) -> Result<Vec<NoteSummary>, String> {
    // 過去の編集で本文に混入した化けメタデータを、最初の一覧より前に一度だけ直す。
    // setup でやらないのは、Android の `app_data_dir` がメインスレッドから
    // 呼べないのと、修復前の一覧が一瞬でも画面に出るのを避けるため。
    // 修復に失敗してもノートが読めなくなるよりは、そのまま出すほうがいい。
    static REPAIR: std::sync::Once = std::sync::Once::new();

    let base_dir = app_base_dir(&handle)?;
    REPAIR.call_once(|| {
        let _ = magical_merchant_core::repair_notes(&base_dir);
    });

    magical_merchant_core::list_notes(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note(handle: AppHandle, filename: String) -> Result<NoteRead, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    let body = magical_merchant_core::read_note_by_filename(&base_dir, &filename)
        .map_err(|e| e.to_string())?;
    let revision = Revision::of(&body).to_string();
    Ok(NoteRead { body, revision })
}

#[tauri::command]
fn find_backlinks(handle: AppHandle, filename: String) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::find_backlinks(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_note_meta(handle: AppHandle, filename: String) -> Result<NoteMeta, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_note_meta(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_note_meta(
    handle: AppHandle,
    filename: String,
    time: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    // オフセット付きの RFC 3339 で受ける。素の日時にすると、端末のタイム
    // ゾーンが変わっただけで同じ入力が別の時刻を指してしまう
    let time = chrono::DateTime::parse_from_rfc3339(&time).map_err(|e| e.to_string())?;
    magical_merchant_core::update_note_meta(&base_dir, &filename, time, &tags)
        .map_err(|e| e.to_string())
}

/// 表示モードだけを書き換える。`None` で既定(エディタ)に戻す。
#[tauri::command]
fn set_note_view(handle: AppHandle, filename: String, view: Option<String>) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::update_note_view(&base_dir, &filename, view.as_deref())
        .map_err(|e| e.to_string())
}

/// 昇格元エントリとの繋がりだけを書き換える。`None` で関係を解く。
#[tauri::command]
fn set_note_origin(
    handle: AppHandle,
    filename: String,
    origin: Option<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::update_note_origin(&base_dir, &filename, origin.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_templates(handle: AppHandle) -> Result<Vec<TemplateSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_templates(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_template(handle: AppHandle, filename: String) -> Result<TemplateDetail, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::read_template(&base_dir, &filename).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_template(
    handle: AppHandle,
    filename: String,
    body: String,
    tags: Vec<String>,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::save_template(&base_dir, &filename, &body, &tags)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_template(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::delete_template(&base_dir, &filename).map_err(|e| e.to_string())
}

/// テンプレからノートを作る。同じテンプレの今日のぶんが既にあれば、
/// 作らずにそれを返す(`reused`)。
///
/// `locale` を受けるのは `{{weekday}}` のため。曜日の呼び名だけは端末の
/// 言語に従うべきで、その言語を知っているのは画面側だけ。
#[tauri::command]
fn create_from_template(
    handle: AppHandle,
    filename: String,
    client: ClientContext,
    locale: String,
) -> Result<CreatedNote, String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    let context = device::get_context(client);
    magical_merchant_core::create_note_from_template(
        &base_dir,
        &filename,
        &context,
        VarLocale::parse(&locale),
        Provenance::default(),
    )
    .map_err(|e| e.to_string())
}

fn parse_glyph_name(name: &str) -> Result<GlyphName, String> {
    GlyphName::parse(name).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_glyphs(handle: AppHandle) -> Result<Vec<GlyphSummary>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::list_glyphs(&base_dir).map_err(|e| e.to_string())
}

/// 画面が `:name:` を描くときに引く 1 件。
#[derive(serde::Serialize)]
struct GlyphAsset {
    name: String,
    /// `data:image/...;base64,...`。
    url: String,
}

/// 登録済みのグリフを全部、データ URL で返す。
///
/// 1 回で全部返すのは、画面側が本文を描く途中で同期的に名前を引けるように
/// するため。asset プロトコルやカスタムスキームで配らないのは、新しい
/// capability を開けずに済み、ブラウザのハーネスでもそのまま真似できるから。
#[tauri::command]
fn read_glyphs(handle: AppHandle) -> Result<Vec<GlyphAsset>, String> {
    let base_dir = app_base_dir(&handle)?;
    let mut assets = Vec::new();
    for summary in magical_merchant_core::list_glyphs(&base_dir).map_err(|e| e.to_string())? {
        // 一覧に出た直後に消えた 1 枚のために全部を失敗させない
        let Ok(name) = GlyphName::parse(&summary.name) else {
            continue;
        };
        let Ok(glyph) = magical_merchant_core::read_glyph(&base_dir, &name) else {
            continue;
        };
        assets.push(GlyphAsset {
            name: summary.name,
            url: format!(
                "data:{};base64,{}",
                glyph.format.mime(),
                B64.encode(&glyph.bytes)
            ),
        });
    }
    Ok(assets)
}

#[tauri::command]
fn save_glyph(
    handle: AppHandle,
    name: String,
    format: String,
    data_base64: String,
) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let name = parse_glyph_name(&name)?;
    let format = GlyphFormat::parse(&format).map_err(|e| e.to_string())?;
    let bytes = B64.decode(data_base64).map_err(|e| e.to_string())?;
    magical_merchant_core::save_glyph(&base_dir, &name, format, &bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_glyph(handle: AppHandle, name: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let name = parse_glyph_name(&name)?;
    magical_merchant_core::delete_glyph(&base_dir, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_timeline_dates(handle: AppHandle) -> Result<Vec<String>, String> {
    let base_dir = app_base_dir(&handle)?;
    let dates = magical_merchant_core::list_timeline_dates(&base_dir).map_err(|e| e.to_string())?;
    Ok(dates
        .iter()
        .map(|d| d.format("%Y-%m-%d").to_string())
        .collect())
}

#[tauri::command]
fn read_timeline_by_date(handle: AppHandle, date: String) -> Result<Vec<String>, String> {
    let base_dir = app_base_dir(&handle)?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::read_timeline(&base_dir, naive).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_timeline_entry(handle: AppHandle, date: String, index: usize) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let naive = chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    magical_merchant_core::delete_timeline_entry(&base_dir, naive, index).map_err(|e| e.to_string())
}

/// 座標を地名に直す。引けたものだけを `"緯度,経度"` のキー付きで返す。
///
/// 記録は座標のまま。返すのは読むときの言い換えで、引けなかった座標が
/// 抜けていても呼び出し側は座標を出せばよい。
///
/// `async` なのはこれがメインスレッドで走ってはいけないため。同期コマンドは
/// メインスレッドで実行され、ジオコーダの答えもメインキューに載る。そこで
/// 待つと自分の返事を自分で塞ぎ、必ず時間切れになる。
#[tauri::command]
async fn resolve_places(
    handle: AppHandle,
    coordinates: Vec<(f64, f64)>,
    locale: String,
) -> Result<Vec<(String, String)>, String> {
    let base_dir = app_base_dir(&handle)?;
    tauri::async_runtime::spawn_blocking(move || place::resolve(&base_dir, &coordinates, &locale))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn search_all(
    handle: AppHandle,
    query: String,
    tags: Vec<String>,
) -> Result<Vec<SearchHit>, String> {
    let base_dir = app_base_dir(&handle)?;
    magical_merchant_core::search_all(&base_dir, &query, &tags).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(handle: AppHandle, filename: String) -> Result<(), String> {
    let base_dir = app_base_dir(&handle)?;
    let filename = parse_filename(&filename)?;
    magical_merchant_core::delete_note(&base_dir, &filename).map_err(|e| e.to_string())
}

/// OAuth のコールバックで返ってきた JWT を保存する。
/// 保存結果をフロントに通知しないと、ログイン完了が UI に反映されず
/// 失敗も握りつぶされてしまう。
///
/// Android では `app_data_dir` がプラグインへの同期呼び出しで、その応答を運ぶ
/// のはメインスレッド。deep link のイベントはそのメインスレッドで配送されるため、
/// ここで直に呼ぶと自分の応答を待って Activity ごと固まる。必ず別スレッドに移す。
fn store_token_from_urls(handle: &AppHandle, urls: &[url::Url]) {
    let Some(token) = urls
        .iter()
        .flat_map(url::Url::query_pairs)
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
    else {
        return;
    };

    let handle = handle.clone();
    std::thread::spawn(move || {
        let stored = app_base_dir(&handle)
            .and_then(|dir| magical_merchant_core::sync::token::store_token(&dir, &token));

        match stored {
            Ok(()) => {
                let _ = handle.emit("auth-success", ());
            }
            Err(e) => {
                let _ = handle.emit("auth-error", e);
            }
        }
    });
}

// `mobile_entry_point` fixes the signature to `fn run()`, so a failed startup
// has nowhere to be returned to — panicking is the only way to report it.
// `generate_context!` embeds every plugin's permission tables in one value;
// with dialog and fs on board it crosses clippy's stack-frame threshold. It
// is built once at startup, so the frame size is not a concern.
#[allow(clippy::expect_used, clippy::large_stack_frames)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_opener::init())
        // 図の書き出し: 保存ダイアログと、Android の content:// への書き込み
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(sync::AppSyncState::default())
        .setup(|app| {
            // ブラウザで認証している間に OS がアプリを回収すると、トークンは
            // 起動 URL として届く。`new-url` イベントはアプリが生きていた場合に
            // しか飛ばないので、両方を見ないとログインが黙って失敗する。
            //
            // get_current も同期プラグイン呼び出しなので setup の中で待たない。
            let launch_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Ok(Some(urls)) = launch_handle.deep_link().get_current() {
                    store_token_from_urls(&launch_handle, &urls);
                }
            });

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event.urls();
                store_token_from_urls(&handle, &urls);
            });

            // 測位は始めてから最初の 1 件が返るまでに間がある。保存のたびに
            // 頼むのでは間に合わないので、起動と同時に受け取り始める。
            #[cfg(target_os = "macos")]
            location::start(app.handle());

            // 同期の HTTPS は端末の信頼ストアで検証する。Android のそれは
            // Java 側にしか無く、初期化を通さないと最初の同期で必ず落ちる。
            #[cfg(target_os = "android")]
            android_tls::init();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_quick_capture,
            create_draft,
            update_draft,
            list_notes,
            read_note,
            read_note_meta,
            find_backlinks,
            update_note_meta,
            set_note_origin,
            set_note_view,
            list_templates,
            read_template,
            save_template,
            delete_template,
            create_from_template,
            list_glyphs,
            read_glyphs,
            save_glyph,
            delete_glyph,
            list_timeline_dates,
            read_timeline_by_date,
            delete_timeline_entry,
            search_all,
            resolve_places,
            delete_note,
            export::save_export,
            sync::sync_start,
            sync::sync_status,
            auth::auth_login,
            auth::auth_status,
            auth::auth_logout,
            auth::get_sync_config,
            auth::save_sync_config,
            auth::is_sync_config_editable,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
