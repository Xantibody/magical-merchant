# Android Home Screen Widgets

Five widgets from the designs (`2a` = Scrawl capture bar, `2b` = notes,
`4a`–`4c` = templates, from the template editor handoff):

| Widget                         | Size      | Look                                                                              | Tap                                                              |
| ------------------------------ | --------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `CaptureBarWidgetProvider`     | 4×1       | `SCRAWL` + clock, rail, prompt, and today's last entry once there is one          | `QuickCaptureActivity` — writes without opening the app          |
| `NotesNewWidgetProvider`       | 4×1       | `NOTES` + "new note", rail, "tap to start writing", plus square                   | `magical-merchant://widget/new-note`                             |
| `NotesListWidgetProvider`      | 4×2       | `NOTES` header with a plus, then the four most recent notes and their dates       | row → `…/widget/note?file=…`, plus → `…/widget/new-note`         |
| `TemplatesWidgetProvider`      | 4×2       | `TEMPLATES` header, then the first four templates as 2×2 tiles — first filled     | tile → `…/widget/template?name=…`, header → `…/widget/templates` |
| `TemplateButtonWidgetProvider` | 2×1 / 1×1 | One chosen template: name, today's title, and `+` (make today's) or `›` (open it) | `…/widget/template?name=…`; unset or gone → the configuration    |

Once the day has an entry the capture bar's prompt becomes "keep going…" with
that entry's time and head below it, and the sheet grows chips for today's
most-used tags, which insert at the caret.

## What language a widget speaks

The device's, not the app's. The language chosen in Settings lives in the
WebView (`lib/i18n.ts`) and a widget process never starts one, so the strings
split the platform's way instead: `res/values/` is English, `res/values-ja/` is
Japanese, and the launcher resolves both the layouts and the `<receiver>` labels
in the widget picker. Keep the two files at the same set of names — a name in
only one of them falls back silently.

## How the capture bar writes

RemoteViews cannot host an `EditText`, so the bar opens a translucent
`QuickCaptureActivity` (design 1b: scrim + bottom sheet + IME) over the home
screen. Sending calls `WidgetBridge.saveQuickCapture`, a JNI function whose Rust
side lives in [`../src-tauri/src/widget_bridge.rs`](../src-tauri/src/widget_bridge.rs)
and calls the same `magical_merchant_core::save_scrawl_entry` the in-app
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
- `com.magical_merchant.app.widget.WidgetUpdates` and its three methods are
  looked up by name from `src-tauri/src/widget_updates.rs`, the other way
  round. Nothing in Kotlin calls them, so `@Keep` is what stops R8 from
  stripping them in a release build.

The typed text exists in exactly one place — the sheet — so nothing on this
path is allowed to throw. `WidgetBridge.saveCapture` answers `false` for every
failure, including an `UnsatisfiedLinkError`, and `QuickCaptureActivity` shows a
toast and leaves the sheet open rather than dismissing it.

`false` is all the sheet gets: the Rust side folds its `Err` into a bool, and
`android_logger` is initialised in Tauri's `setup`, which a widget process never
runs, so nothing Rust logs from here reaches logcat. What the Kotlin half knows
it says under one tag:

```sh
adb logcat -s MagicalWidget
```

The base directory is `Context.getDataDir()`, **not** `filesDir` — Tauri's
`PathPlugin` answers `getDataDir` with the former, and writing to `files/`
would build a second scrawl the app never reads.

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

## Template buttons

`TemplateButtonWidgetProvider` stands for one template. It is 2×1 when placed
and 1×1 when resized down: on API 31+ it hands the launcher both layouts and the
launcher picks by size, before that it picks once from the reported width. One
provider for both sizes keeps the widget picker at one entry and gives the pin
request one component to name.

Which template it stands for, and whether it also shows today's title, is chosen
in `TemplateButtonConfigureActivity` (the provider's `android:configure`,
reconfigurable with a long press) and kept per `appWidgetId` in this device's
SharedPreferences (`TemplateButtonSettings`). Only the template's name is kept;
a name that no longer matches — renamed or deleted, here or elsewhere — draws
"choose a template" and opens the configuration on tap, rather than a button
that fails.

The app can also place one: the Tauri command `pin_template_widget` calls
`WidgetUpdates.requestPinTemplateButton`, which asks the launcher through
`AppWidgetManager.requestPinAppWidget` (API 26+, and only where the launcher
supports it — `template_widget_pinnable` says whether). The template's name
rides on the callback intent, which the launcher sends back with the new
widget's id, so a pinned button skips the configuration.

The activity is the one exported component: a launcher starts it, and not every
launcher goes through the system to do so. It refuses a widget id that is not
this app's.

## What the widgets read

`readCaptureData` (today's last entry + tags), `readNotes` (the recent list) and
`readTemplates` (the buttons) are separate calls on purpose, split along what
each costs: the sheet reads one day file and has to open instantly, the notes
list reads every note, and the templates read lists the notes once (for
`hasToday` and `{{prev}}`), and only when there is a template at all. The
notes read happens in `RemoteViewsFactory.onDataSetChanged`, which the platform
calls off the main thread; the other two are cheap enough for `onUpdate`.

Kotlin never takes a scrawl line apart. `- [HH:MM:SS] text {json}` is parsed
in [`../src-tauri/src/widget_summary.rs`](../src-tauri/src/widget_summary.rs)
with the same core helpers the app uses.

They all set `updatePeriodMillis` to 30 minutes, the platform minimum. A capture
from the sheet refreshes the bar immediately, and the app redraws the template
widgets itself when it saves or deletes a template, makes a note from one, or
deletes a note (`src-tauri/src/widget_updates.rs` → `WidgetUpdates.refreshTemplates`).
Other entries and notes written _in the app_, and anything a sync brings in,
have no way to tell a widget, so the poll is what catches them up — and what
turns "made today" back off after midnight. It costs a native-library load in our own process per period; the
alternative — a stale bar until the launcher happens to rebind — reads as a bug.

## What the templates widget does not decide

A tap hands `…/widget/template?name=<stem>` to the app, which calls the same
`create_from_template` the in-app menu does. Whether that makes a note or opens
today's existing one is core's rule, not Kotlin's — the widget and the menu have
to agree on "one daily note per day", and they only can while the decision has
a single home. What a button _shows_ comes from the same place: `readTemplates`
carries `todayTitle` (the resolved title, in the device's language for
`{{weekday}}`) and `hasToday`, both from core's `templates_today`, which uses
the helpers `create_note_from_template` decides with. The widget never resolves
`{{date}}` itself.

The 4×2 offers simply the first four by name; the name order is at least
stable, so the same tile keeps making the same note. To place a particular
template, use the button widget.

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
| `widget_ok`        | `#37B24D` | `#69DB7C` |

Geometry: 24dp surface radius with a 1dp border on the bars and 14dp on the
sheet, 12dp radius on the 42dp trailing action (38dp in the sheet), 2dp rail
with a 10dp dot, label 9.5sp (tracking 0.08), time / title 13sp bold,
placeholder 14sp, sheet input 15sp. Template tiles: 14dp radius, name 14sp bold;
the button's initial sits on a 30dp square with a 9dp radius.

`widget_ok` is the app's `--app-ok` and marks "today's note exists" only. On
the filled first tile the state line stays `widget_on_accent`: green on the
accent fill reads poorly in both themes.

## How regeneration is handled

`src-tauri/gen/android/` is gitignored and is recreated by `tauri android init`,
so the sources live here instead. [`apply-widget.go`](apply-widget.go) copies
`src/main/` into the generated project and registers the five `<receiver>`
elements, the two `<activity>` elements and the list `<service>` in `AndroidManifest.xml`
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
`data/scrawl/YYYY-MM-DD.md`:

```sh
adb shell run-as com.magical_merchant.app \
  cat /data/data/com.magical_merchant.app/data/scrawl/$(date +%F).md
```
