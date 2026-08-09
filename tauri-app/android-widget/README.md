# Android Home Screen Widgets

Two 4×1 bars for the home screen, taken from the widget design (`2a` = Timeline
capture bar, `2b` top bar = new note):

| Widget                     | Look                                                                    | Tap                                  |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| `CaptureBarWidgetProvider` | `TIMELINE` + current time, rail, 「いま何してる?」, send square         | `magical-merchant://widget/capture`  |
| `NotesNewWidgetProvider`   | `NOTES` + 「新しいノート」, rail, 「タップして書き始める」, plus square | `magical-merchant://widget/new-note` |

**Presentation only.** Both are static RemoteViews that open the app via the
existing deep link plugin. The functional half of the plan is deliberately not
here: no JNI bridge into `magical_merchant_core`, no `QuickCaptureActivity`
sheet, no recent-notes list, and no frontend routing for the `widget` host — so
a tap currently opens the app on its default screen.

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

Geometry: 24dp surface radius with a 1dp border, 12dp radius on the 42dp
trailing action, 2dp rail with a 10dp dot, label 9.5sp (tracking 0.08), time /
title 13sp bold, placeholder 14sp.

## How regeneration is handled

`src-tauri/gen/android/` is gitignored and is recreated by `tauri android init`,
so the sources live here instead. [`apply-widget.go`](apply-widget.go) copies
`src/main/` into the generated project and registers the two `<receiver>`
elements in `AndroidManifest.xml` behind idempotent marker comments — the same
approach as [`../android-signing`](../android-signing/README.md).

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
system dark theme to check the night palette.
