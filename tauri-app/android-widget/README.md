# Android Home Screen Widgets

Two 4×1 bars for the home screen, taken from the widget design (`2a` = Timeline
capture bar, `2b` top bar = new note):

| Widget                     | Look                                                                    | Tap                                                     |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `CaptureBarWidgetProvider` | `TIMELINE` + current time, rail, 「いま何してる?」, send square         | `QuickCaptureActivity` — writes without opening the app |
| `NotesNewWidgetProvider`   | `NOTES` + 「新しいノート」, rail, 「タップして書き始める」, plus square | `magical-merchant://widget/new-note`                    |

## How the capture bar writes

RemoteViews cannot host an `EditText`, so the bar opens a translucent
`QuickCaptureActivity` (design 1b: scrim + bottom sheet + IME) over the home
screen. Sending calls `WidgetBridge.saveQuickCapture`, a JNI function whose Rust
side lives in [`../src-tauri/src/widget_bridge.rs`](../src-tauri/src/widget_bridge.rs)
and calls the same `magical_merchant_core::save_timeline_entry` the in-app
capture bar uses.

Nothing about the `DayLog` format is reimplemented in Kotlin. Appending from
Kotlin would mean duplicating the frontmatter device table and the row-level
JSON, and any disagreement there surfaces as a sync conflict rather than as a
crash. Writes are atomic, so the app being backgrounded — or open — is fine; it
picks the entry up on its next refetch.

Two names are load-bearing and fail only at runtime if they drift apart:

- `System.loadLibrary("magical_merchant_app_lib")` must match `[lib] name` in
  `src-tauri/Cargo.toml`.
- `Java_com_magical_1merchant_app_widget_WidgetBridge_saveQuickCapture` is the
  JNI mangling of this package + object + method (`_` in a package component
  escapes to `_1`). Renaming the Kotlin side means renaming the Rust symbol.

The base directory is `Context.getDataDir()`, **not** `filesDir` — Tauri's
`PathPlugin` answers `getDataDir` with the former, and writing to `files/`
would build a second timeline the app never reads.

Not implemented yet: the recent-notes list (`RemoteViewsService`), the
「続きを記録…」 last-entry preview, and tag chips in the sheet. Entries written
from the widget also carry no battery/network/location — the sheet has no
WebView to ask, and `Context` simply omits absent fields.

## Design tokens

Written to `res/values/widget_colors.xml` and `res/values-night/widget_colors.xml`,
mirroring the app's tokens so the widgets flip with the system theme:

| Token              | Light     | Dark      |
| ------------------ | --------- | --------- |
| `widget_bg`        | `#F8F9FA` | `#212529` |
| `widget_border`    | `#DEE2E6` | `#495057` |
| `widget_text`      | `#212529` | `#F1F3F5` |
| `widget_muted`     | `#ADB5BD` | `#868E96` |
| `widget_rail`      | `#F1F3F5` | `#343A40` |
| `widget_accent`    | `#343A40` | `#CED4DA` |
| `widget_on_accent` | `#FFFFFF` | `#212529` |

Geometry: 24dp surface radius with a 1dp border on the bars and 14dp on the
sheet, 12dp radius on the 42dp trailing action (38dp in the sheet), 2dp rail
with a 10dp dot, label 9.5sp (tracking 0.08), time / title 13sp bold,
placeholder 14sp, sheet input 15sp.

## How regeneration is handled

`src-tauri/gen/android/` is gitignored and is recreated by `tauri android init`,
so the sources live here instead. [`apply-widget.go`](apply-widget.go) copies
`src/main/` into the generated project and registers the two `<receiver>`
elements and the `<activity>` in `AndroidManifest.xml` behind idempotent marker
comments — the same approach as
[`../android-signing`](../android-signing/README.md).

```sh
just android-widget-setup
```

`android-build-debug` and `android-build-release` depend on it, so
`just android-install` / `just android-install-release` pick the widgets up on
their own. `just android-dev` does **not** — run the recipe once by hand before
`android-dev` if you want the widgets in a dev build.

## Trying it

```sh
just android-install
```

Then long-press the home screen → ウィジェット → Magical Merchant. Toggle the
system dark theme to check the night palette, and confirm a sent entry lands in
`data/timeline/YYYY-MM-DD.md`:

```sh
adb shell run-as com.magical_merchant.app \
  cat /data/data/com.magical_merchant.app/data/timeline/$(date +%F).md
```
