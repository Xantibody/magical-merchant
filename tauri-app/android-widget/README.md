# Android Home Screen Widgets

Three widgets from the design (`2a` = Timeline capture bar, `2b` = notes):

| Widget                     | Size | Look                                                                        | Tap                                                      |
| -------------------------- | ---- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `CaptureBarWidgetProvider` | 4×1  | `TIMELINE` + clock, rail, prompt, and today's last entry once there is one  | `QuickCaptureActivity` — writes without opening the app  |
| `NotesNewWidgetProvider`   | 4×1  | `NOTES` + 「新しいノート」, rail, 「タップして書き始める」, plus square     | `magical-merchant://widget/new-note`                     |
| `NotesListWidgetProvider`  | 4×2  | `NOTES` header with a plus, then the four most recent notes and their dates | row → `…/widget/note?file=…`, plus → `…/widget/new-note` |

Once the day has an entry the capture bar's prompt becomes 「続きを記録…」 with
that entry's time and head below it, and the sheet grows chips for today's
most-used tags, which insert at the caret.

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
- `Java_com_magical_1merchant_app_widget_WidgetBridge_saveQuickCapture` (and the
  two read functions) is the JNI mangling of this package + object + method
  (`_` in a package component escapes to `_1`). Renaming the Kotlin side means
  renaming the Rust symbol.

The base directory is `Context.getDataDir()`, **not** `filesDir` — Tauri's
`PathPlugin` answers `getDataDir` with the former, and writing to `files/`
would build a second timeline the app never reads.

Entries written from the widget carry no battery, network or location: the
sheet has no WebView to ask, and `Context` omits absent fields, so they are
shorter than in-app entries rather than wrong.

## What the widgets read

`readCaptureData` (today's last entry + tags) and `readNotes` (the recent list)
are two calls on purpose, split along what each costs: the sheet reads one day
file and has to open instantly, while the notes list reads every note. The
notes read happens in `RemoteViewsFactory.onDataSetChanged`, which the platform
calls off the main thread.

Kotlin never takes a timeline line apart. `- [HH:MM:SS] text {json}` is parsed
in [`../src-tauri/src/widget_summary.rs`](../src-tauri/src/widget_summary.rs)
with the same core helpers the app uses.

Both widgets set `updatePeriodMillis` to 30 minutes, the platform minimum. A
capture from the sheet refreshes the bar immediately, but entries and notes
written _in the app_ have no way to tell a widget, so the poll is what catches
them up. It costs a native-library load in our own process per period; the
alternative — a stale bar until the launcher happens to rebind — reads as a bug.

## Design tokens

Written to `res/values/widget_colors.xml` and `res/values-night/widget_colors.xml`,
mirroring the app's tokens so the widgets flip with the system theme:

| Token              | Light     | Dark      |
| ------------------ | --------- | --------- |
| `widget_bg`        | `#F8F9FA` | `#212529` |
| `widget_border`    | `#DEE2E6` | `#495057` |
| `widget_text`      | `#212529` | `#F1F3F5` |
| `widget_muted`     | `#ADB5BD` | `#868E96` |
| `widget_faint`     | `#868E96` | `#495057` |
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
`src/main/` into the generated project and registers the three `<receiver>`
elements, the `<activity>` and the list `<service>` in `AndroidManifest.xml`
behind idempotent marker comments — the same approach as
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
