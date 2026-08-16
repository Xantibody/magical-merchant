# Android ホーム画面ウィジェット実装プラン

デザイン: `Android Widgets.dc.html`(2a = Timeline キャプチャバー 4×1、2b = ノート版)。
本プランはリポジトリの現行実装(`save_quick_capture` → `magical_merchant_core::save_timeline_entry`、deep link `magical-merchant://auth`、`android-signing` の Gradle パッチャー)を前提にする。

## 方針

- **保存フォーマットを Kotlin で再実装しない。** `DayLog` は frontmatter に端末一覧を圧縮し、行末 JSON が `"d"` で参照する形式。Kotlin で追記すると同期(ハッシュ比較)とレガシー互換を壊す。書き込みは必ず JNI 経由で `magical_merchant_core` を呼ぶ。
- **アプリ本体を起動しない入力**は、透過テーマの軽量アクティビティ(QuickCaptureActivity)で実現する。RemoteViews に EditText は置けない。
- **アプリを開く系のタップ**は既存の deep link 基盤に乗せる(認証で配線済み)。

## フェーズ 1 — deep link 拡張 + 「新しいノート」バー(JNI 不要)

### 1-1. tauri.conf.json

`plugins.deep-link.mobile` に host を追加:

```json
"mobile": [
  { "scheme": ["magical-merchant"], "host": "auth" },
  { "scheme": ["magical-merchant"], "host": "widget" }
]
```

### 1-2. フロントエンドのルーティング

`AppLayout.tsx` の `onMount` で `onOpenUrl`(`@tauri-apps/plugin-deep-link`)を購読:

- `magical-merchant://widget/capture` → `navigate(ROUTES.TIMELINE)` + キャプチャ欄フォーカス(CaptureBar に `autofocus` シグナルを渡すか、shell にイベントを足す)
- `magical-merchant://widget/new-note` → 既存の `newNote()` をそのまま呼ぶ
- `magical-merchant://widget/note?file=<filename>` → `ROUTES.NOTES` へ navigate + 該当ノートを選択

Rust 側 `store_token_from_urls` は `token` クエリしか見ないので変更不要。

### 1-3. NotesNewWidget(2b 上段)

- `NotesNewWidgetProvider : AppWidgetProvider` + 静的 RemoteViews。タップで
  `Intent(ACTION_VIEW, "magical-merchant://widget/new-note".toUri())` の PendingIntent。
- アプリ側で `create_draft` → エディタ表示、は既存 `newNote()` が全部やる。

## フェーズ 2 — JNI ブリッジ + QuickCaptureActivity + 2a バー

### 2-1. JNI エクスポート(src-tauri)

`src-tauri/src/widget_bridge.rs`(`#[cfg(target_os = "android")]` で丸ごと囲む。依存: `jni` クレート):

```rust
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::jboolean;
use magical_merchant_core::utils::device::Context;
use std::path::Path; // 公開パスは要確認

// identifier "com.magical-merchant.app" の JNI 名: `-` は `_1` にエスケープ
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_magical_1merchant_app_WidgetBridge_saveQuickCapture(
    mut env: JNIEnv,
    _c: JClass,
    base_dir: JString,
    text: JString,
) -> jboolean {
    let (Ok(dir), Ok(text)) = (env.get_string(&base_dir), env.get_string(&text)) else {
        return 0;
    };
    let ctx = Context {
        os: "android".into(),
        arch: std::env::consts::ARCH.into(),
        ..Context::default()
    };
    magical_merchant_core::save_timeline_entry(
        Path::new(&String::from(dir)),
        &String::from(text),
        &ctx,
    )
    .is_ok()
    .into()
}
```

注意:

- Kotlin 側クラスの FQCN と関数名が JNI シンボルに一致すること(パッケージを変えるならシンボルも変える)。
- `Context` を組む API が非公開なら、core に `save_timeline_entry_bare(base_dir, text, os, arch)` のような薄い公開関数を足す方が安全。
- context(バッテリー等)は v1 では省略でよい。`Context::default()` 相当はコアがテスト済みの経路で処理する。将来 Kotlin から BatteryManager / ConnectivityManager の値を引数で渡せば埋まる。

### 2-2. Kotlin ブリッジ

```kotlin
object WidgetBridge {
    init { System.loadLibrary("<libname>") } // src-tauri/Cargo.toml の [lib] name を確認
    external fun saveQuickCapture(baseDir: String, text: String): Boolean
}
// baseDir は context.filesDir.absolutePath — Tauri の app_data_dir と同一
```

### 2-3. QuickCaptureActivity(フローティングシート)

Manifest:

```xml
<activity android:name=".QuickCaptureActivity"
    android:theme="@style/Theme.QuickCapture"
    android:excludeFromRecents="true"
    android:noHistory="true"
    android:windowSoftInputMode="adjustResize|stateAlwaysVisible" />
```

`Theme.QuickCapture`: `windowIsTranslucent=true`、`windowBackground=@android:color/transparent`、`backgroundDimEnabled=true`(dimAmount 0.45 — モック 1b/1e の scrim)。

レイアウト(デザイン 1b シート準拠): 画面下に角丸 14dp カード(`#f8f9fa` / night `#212529`、border 1dp `#dee2e6` / `#495057`)。中身は EditText(15sp、背景なし)+ 38dp 送信ボタン(角丸 12dp、`#343a40` / `#ced4da`、paper-plane-tilt アイコン)。タグ補完行は v3。

送信: `WidgetBridge.saveQuickCapture(filesDir.absolutePath, text)` → 成功で `finish()`。保存は `write_atomic` なのでアプリがバックグラウンドにいても安全。アプリ側の表示は resume 時の refetch で追いつく(必要なら FE で visibilitychange → `shell.refreshData()` を 1 行足す)。

### 2-4. CaptureBarWidget(2a、4×1)

- レイアウト: LinearLayout 横並び —
  - 左: 縦 2 段(「TIMELINE」9.5sp letterSpacing 0.08 `#adb5bd`、**TextClock** `format24Hour="HH:mm"` 13sp bold)。TextClock なので分単位更新に AlarmManager 不要
  - レール: 2dp 縦線 `#f1f3f5` + 10dp 丸ドット `#343a40`(layer-list drawable)
  - 中央: プレースホルダ TextView「いま何してる?」14sp `#adb5bd`
  - 右: 42dp 送信風アイコン(見た目のみ)
- 背景: 角丸 24dp shape、`values/` と `values-night/` にトークンを写す
  (bg `#f8f9fa`/`#212529`、border `#dee2e6`/`#495057`、text `#212529`/`#f1f3f5`、muted `#adb5bd`/`#868e96`、accent `#343a40`/`#ced4da`)
- 全面タップ → QuickCaptureActivity。
- provider info: `targetCellWidth="4" targetCellHeight="1"`、`minWidth="250dp" minHeight="40dp"`、`resizeMode="horizontal"`、`previewLayout` に同レイアウト、`updatePeriodMillis="0"`(静的 + TextClock)。

## フェーズ 3 — 読み取り系(v2/v3)

- JNI に読み取りを追加(JSON 文字列で返す): `readTimelineToday(baseDir): String`(`read_timeline` の expanded 行配列)、`listNotes(baseDir): String`(`list_notes` の title/filename/日付)。
- **2a「続きを記録…」変形**: 最後の 1 行(時刻 + 本文先頭)を薄く表示。QuickCaptureActivity の保存成功後と `ACTION_BOOT_COMPLETED` / 定期(30分)で `updateAppWidget`。
- **2b 最近のノート 4×2**: `RemoteViewsService` + ListView。行タップは `setOnClickFillInIntent` で `widget/note?file=<filename>`、ヘッダー右の「+新規」は `widget/new-note`。
- タグ補完行(シート内): `readTimelineToday` から `#tag` を数えて上位 2–3 個をチップ表示、タップで挿入。

## ビルド配線

`gen/android` は `tauri android init` の生成物。widget ソース(Kotlin / res / Manifest 追記)は生成物に直接置くと `android-init` で消える。**`tauri-app/android-widget/` にソースを置き、`android-signing` パッチャーと同じ流儀で `just` レシピから注入する**(Manifest への `<receiver>` / `<activity>` 追記もパッチャーで)。`just tauri_app::android-sign-setup` と並ぶ `android-widget-setup` レシピにする。

## 受け入れ確認

1. ウィジェット配置 → タップ → ホーム上にシート + IME、送信 → シートが閉じる
2. `data/timeline/YYYY-MM-DD.md` に追記され、既存行が 1 バイトも変わらない(レガシー日への追記テストと同じ観点)
3. アプリを開くと新エントリが Timeline に出る
4. 同期後、macOS 側に届く。コンフリクトが起きない
5. ダークテーマ(values-night)で 2a/シートの配色が反転する
6. 「新しいノート」バー → アプリが Notes タブ + 新規ドラフトで開く
