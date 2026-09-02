# Android Home Screen Widgets

Four widgets from the design (`2a` = Timeline capture bar, `2b` = notes,
`1e` = templates):

| Widget                     | Size | Look                                                                         | Tap                                                             |
| -------------------------- | ---- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `CaptureBarWidgetProvider` | 4×1  | `TIMELINE` + clock, rail, prompt, and today's last entry once there is one   | `QuickCaptureActivity` — writes without opening the app         |
| `NotesNewWidgetProvider`   | 4×1  | `NOTES` + 「新しいノート」, rail, 「タップして書き始める」, plus square      | `magical-merchant://widget/new-note`                            |
| `NotesListWidgetProvider`  | 4×2  | `NOTES` header with a plus, then the four most recent notes and their dates  | row → `…/widget/note?file=…`, plus → `…/widget/new-note`        |
| `TemplatesWidgetProvider`  | 4×3  | `TEMPLATES` header, then up to three templates — first filled, rest outlined | row → `…/widget/template?name=…`, header → `…/widget/templates` |

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
  three read functions) is the JNI mangling of this package + object + method
  (`_` in a package component escapes to `_1`). Renaming the Kotlin side means
  renaming the Rust symbol.

The base directory is `Context.getDataDir()`, **not** `filesDir` — Tauri's
`PathPlugin` answers `getDataDir` with the former, and writing to `files/`
would build a second timeline the app never reads.

### What the entry knows about the device

The sheet has no WebView, and on Android the Rust side sees neither battery nor
network, so `WidgetContext` gathers what Kotlin can and hands it over as the
same JSON `ClientContext` takes from the app:

| Field                    | Source                                       | Permission                       |
| ------------------------ | -------------------------------------------- | -------------------------------- |
| `battery` / `isCharging` | sticky `ACTION_BATTERY_CHANGED`              | none                             |
| `networkType`            | `ConnectivityManager` transports             | `ACCESS_NETWORK_STATE` (already) |
| `osVersion`              | `Build.VERSION.RELEASE`                      | none                             |
| `locale`                 | `Locale.getDefault()`, normalized to `ja_JP` | none                             |
| `latitude` / `longitude` | last known fix, **only if already granted**  | location, never requested here   |

Nothing is measured or awaited. A permission dialog on the home screen, or a
wait for a GPS fix, costs more than the value it buys in a sheet meant to be
typed into the instant it opens — so an entry written before the app has ever
been granted location simply carries none. `Context` omits absent fields, so a
thinner entry is shorter than an in-app one rather than wrong.

## What the widgets read

`readCaptureData` (today's last entry + tags), `readNotes` (the recent list) and
`readTemplates` (the buttons) are separate calls on purpose, split along what
each costs: the sheet reads one day file and has to open instantly, the notes
list reads every note, and the templates read opens only `data/templates/`. The
notes read happens in `RemoteViewsFactory.onDataSetChanged`, which the platform
calls off the main thread; the other two are cheap enough for `onUpdate`.

Kotlin never takes a timeline line apart. `- [HH:MM:SS] text {json}` is parsed
in [`../src-tauri/src/widget_summary.rs`](../src-tauri/src/widget_summary.rs)
with the same core helpers the app uses.

They all set `updatePeriodMillis` to 30 minutes, the platform minimum. A capture
from the sheet refreshes the bar immediately, but entries, notes and templates
written _in the app_ have no way to tell a widget, so the poll is what catches
them up. It costs a native-library load in our own process per period; the
alternative — a stale bar until the launcher happens to rebind — reads as a bug.

## What the templates widget does not decide

A tap hands `…/widget/template?name=<stem>` to the app, which calls the same
`create_from_template` the in-app menu does. Whether that makes a note or opens
today's existing one is core's rule, not Kotlin's — the widget and the menu have
to agree on "one daily note per day", and they only can while the decision has
a single home. The widget likewise never resolves `{{date}}`.

The templates it offers are simply the first three by name. Choosing them
per-widget would need a configuration `Activity`; the name order is at least
stable, so the same button keeps making the same note.

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
`src/main/` into the generated project and registers the four `<receiver>`
elements, the `<activity>` and the list `<service>` in `AndroidManifest.xml`
behind idempotent marker comments — the same approach as
[`../android-signing`](../android-signing/README.md).

The copy includes one file that is not a widget:
[`MainActivity.kt`](src/main/java/com/magical_merchant/app/MainActivity.kt)
overwrites the Tauri-generated stub to pad the content view by the IME inset
(#54 — `enableEdgeToEdge()` stops `adjustResize` from working, so without this
the keyboard-top markdown toolbar falls back to jittery JS positioning). After
a Tauri upgrade, diff the regenerated stub against ours before re-applying.

```sh
just android-setup
```

`android-build-debug` and `android-build-release` depend on it, so
`just android-install` / `just android-install release` pick the widgets up on
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
