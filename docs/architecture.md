# Code layout

Where code goes and which way imports point. The
[architecture overview](introduction.md) describes what the parts do; this
page is the map to read before adding a file. It records the layout that was
decided. `core/src` and `backend/src` stand that way now; where another part
of the tree still predates it, the rules here win and the code moves when it
is next reworked.

Other guides: [Feature tour](features.md) ·
[Development](development.md) · [Install](install.md) ·
[Sync backend](sync.md)

## Top level

One directory answers to one test command, so a change names the tests it
needs by where it is.

| Directory   | Holds                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `frontend/` | The SolidJS app: `src/`, the two pages, `public/`, the Vite / Vitest / TypeScript config, the IPC mock  |
| `backend/`  | The Tauri crate (`magical-merchant-app`): the commands the webview calls, the plugins, the bundle       |
| `core/`     | `magical-merchant-core`: everything the app, the CLI, the MCP server and the widgets share              |
| `cli/`      | `magical-merchant-cli`: the terminal client and the MCP server                                          |
| `android/`  | The Go patchers applied to the generated `backend/gen/android` (widget, TLS, signing) and their recipes |
| `worker/`   | The Cloudflare Worker that syncs through R2                                                             |
| `tests/`    | Tools that test the whole app from outside it: `screens/` (every screen as pictures and trees, diffed)  |
| `xtask/`    | `cargo xtask sandbox …`                                                                                 |
| `fixtures/` | One record of every surface, read by the core's tests                                                   |
| `nix/`      | Packages, modules and the devshells                                                                     |
| `rust/`     | The Rust just recipes                                                                                   |
| `docs/`     | These pages                                                                                             |

## `core/src`

Three places, and imports go one way:

```
utils  <-  services  <-  domain  <-  backend, cli
```

- **`services/`** talks to one outside party and only communicates. A file
  is named after the party, never after the role it plays for us:
  `files.rs` (the local file system: reads, atomic and owner-only writes,
  walks, renames, locks), `worker.rs` (the sync Worker over HTTP),
  `keyring.rs` (the OS keyring), `os.rs` (the device probe and decoding what
  the OS answers).
- **`utils/`** knows nothing about this app; a file could be carried to
  another project as it is: `clock/` (every time the app prints, parses or
  takes), `diff.rs` (line diff), `error.rs` (`CoreError`, `SyncError`,
  `describe`), `frontmatter.rs` (the generic `---` split, parse and render),
  `text.rs` (snippets, highlight spans, fast lowercase). Nothing else goes
  here.
- **`domain/`** is this app's rules and the operations that apply them. The
  app, the CLI, the MCP server and the widget all share it, which is what
  earns a domain layer here.

The tree as it stands, each thing's rule files first and its operation files
after:

```
core/src/
  lib.rs           the three layers, then the re-exported names (utils, then domain)
  domain/
    data.rs        where data/ is; each kind's directory hangs off it
    note/          file, id, kind, revision, row
                   + create, open, list, edit, details, delete, history, conflicts, repair
    codex/         version
                   + draft, commit, compare, restore, promote
    scrawl/        entry (one line), day (the day file)
                   + capture (add a line), journal (read days back, or between two), delete, migrate (data/timeline/)
    templates/     file, variables, today
                   + folder, edit, draft, new_note
    glyphs/        image
                   + register, lookup
    tags/          tag (the #tag rules)
                   + usage (counting over all records)
    search.rs      the search field
    browse.rs      Browse
    backlinks.rs   records pointing here
    device/        context, place
                   + place_names, current_context, visits
    sync/          diff, rounds, conflict_copy, token, result
                   + run, login, settings, scan, state
  services/        files.rs  worker.rs  keyring.rs  os.rs
  utils/           clock/  diff.rs  error.rs  frontmatter.rs  text.rs
```

Inside `domain/`:

- A **rule file** (`file.rs`, `id.rs`, `version.rs`, …) is pure: it never
  uses `services/`, so its tests are plain inputs and outputs.
- An **operation file** applies the rules to disk or the network and is the
  only kind that may use `services/`. It is named after the product's
  action (a Codex commit, a Scrawl line), not after a service verb such as
  read or write. The parts that reach the network, the keyring or the OS are
  passed in, so a test never touches them; the file system is used for real
  over a temporary directory.

Imports between things inside `domain/`:

- A rule file imports only rule files, its own thing's or another's.
- An operation file may import another thing's rule files, and another
  thing's operations in one direction only. A Codex's operations open and
  save its draft through `note/`; `note/` uses nothing of `codex/` but the
  rule file `version.rs` (the list row's version mark, where a Codex keeps
  its versions).
- No cycle between files. Two things may still lean on each other, as
  `note/` and `codex/` do, while every file-level edge points one way.
- `browse.rs` and `backlinks.rs` walk the Scrawl days and title their rows
  through `search.rs`; `search.rs` imports neither. The `#tag` rules are
  the rule file `tags/tag.rs`, which the note list row uses; the counting in
  `tags/usage.rs` scans every note, which is why `tags/` is a directory
  rather than one file.
- `device/` is where and with what a record was written. Its rule files are
  `context.rs` (the device block a record keeps, split into the day file's
  head and each line's tail, the entry point that wrote it, and how the
  signals a `WebView` or the widget read fill the gaps the native side left:
  `ClientContext`, `fill_from_client`) and
  `place.rs` (how coarsely coordinates count as one place, and the
  per-language lookup of a cached name). Its operations are
  `place_names.rs` (`places.json`, kept beside `data/` so it never syncs,
  and `resolve`, which asks a geocoder passed in for the names it lacks),
  `current_context.rs` (asking the OS and filling the gaps from the client,
  behind the `device-probe` feature) and `visits.rs` (every place records were written at, counted
  by cell over the Scrawl days and the notes, which it reads through
  `scrawl/` and `note/`; neither of those uses more of `device/` than its
  rule files).
- `sync/` is one sync with the Worker. Its rule files are `diff.rs` (what to
  upload, download, delete or keep as a conflict, and the records it
  compares: `LocalFile`, `RemoteFile`, `SyncState`), `rounds.rs` (how many of
  those fit one bulk), `conflict_copy.rs` (a conflict copy's name),
  `token.rs` (a login's expiry and when to renew it) and `result.rs` (what
  one sync reports, `SyncResult` and `SyncIssue`). Its operations are
  `run.rs` (one sync: the lock, the rounds, the bulk and applying the reply;
  kept as one file), `scan.rs` (walking `data/` with its hash cache),
  `state.rs` (`SyncState` to and from `.sync-state.json`), `settings.rs` (`sync-config.json`) and `login.rs` (storing,
  reading and renewing the login). Only the parts that speak HTTP sit behind
  the `sync-client` feature; `diff`, `scan`, `state`, `conflict_copy` and
  `result` build without it, for the widget and the MCP-only CLI.
- `note/` and `sync/` lean on each other at the file level in one direction
  each: `note/conflicts.rs` names copies with the rule file
  `sync/conflict_copy.rs`, and `sync/run.rs` calls the note repair and
  relocation operations before it scans. The naming rule stays in `sync/`
  because day files, templates and Codex versions get conflict copies too.

Names:

- A first-level name is the same thing in every layer; the layer directory
  says which side of it a file is.
- Proper nouns and actions are singular (`note`, `codex`, `scrawl`, `sync`,
  `search`, `browse`); collections are plural after their `data/` directory
  (`templates`, `glyphs`, `conflicts`, `backlinks`).
- A module's entry file (`note.rs`) holds only `mod` lines and `pub use`.
- `lib.rs` re-exports keep their public names. Callers in `backend/` and
  `cli/` import the real path; there are no compatibility aliases.

Two exceptions, each with a one-line anchor at the top of its file:

- `utils/error.rs` names this app's errors (`CoreError::Stale`, `NotCodex`).
  Services and domain both return them, and services may not import domain,
  so the types sit below both.
- `utils/clock/zone.rs` asks the OS for the time zone. It stays in `clock`:
  threading a zone through every "now" would cost more than it gains.

Two tests hold the tree to this page. `core/tests/layers.rs` reads the
sources and fails on an import against the direction above, on code in an
entry file and on a rule file that names a service; its list of allowed
exceptions is empty, and a test keeps it so. It also pins `utils/` to its
five modules. `core/tests/public_api.rs` touches every name `lib.rs`
re-exports, so a name dropped in a move fails even when no caller uses it.

## `backend/src`

The Tauri crate is entries and the outside parties they talk to; what two
entries share is core's.

```
backend/src/
  main.rs          calls run()
  lib.rs           module lines and `pub use app::{run, run_with}`
  app.rs           run(): the plugins, setup, the managed state, the one generate_handler! list;
                   run_with(), the same with plugins added first (tests/screens/app)
  commands/        what the webview calls, one file per thing in core/src/domain's words
    note.rs  codex.rs  scrawl.rs  templates.rs  glyphs.rs  search.rs  browse.rs
    tags.rs  backlinks.rs  device.rs  markdown.rs (the diagram export)
    sync/          run.rs (a round)  login.rs (signing in)  settings.rs (sync-config.json)
    error.rs       CommandError, the one shape every command refuses with
  links.rs         entry: the OS opened a magical-merchant:// link (the login token, a Scrawl line)
  shortcut.rs      entry: the desktop's global key that floats the one-line window
  widget/          entry: the Android widget, through JNI
    bridge.rs      the JNI symbols
    summary.rs     what the widget reads
  services/        one outside party each, named after it
    tauri.rs       the data directory and the blocking pool
    windows.rs     the webview windows: the one-line window, the sign-in window, the captured event
    loopback.rs    the sign-in callback on 127.0.0.1
    geocoder.rs    the OS reverse geocoder
    core_location.rs  macOS CoreLocation (None elsewhere)
    android.rs     the JavaVM and the application Context
    android_tls.rs the trust store handed to rustls
    widgets.rs     Kotlin's WidgetUpdates (refresh, pin)
```

- **An entry is named after what calls it**: the webview (`commands/`), the
  OS opening a link (`links.rs`), the global key (`shortcut.rs`), the
  widget (`widget/`). An entry only reads its input, calls core and the
  services, and answers.
- **`services/` talks to one outside party and only communicates**, named
  after the party (`geocoder.rs`, not `places.rs`). An entry that needs one
  names it, and a core operation that needs one takes it as a parameter
  (`place_names::resolve` takes the geocoder, `probe_with_client` the
  macOS fix), so a test passes a fake.
- **Code only one entry uses sits beside that entry**: `token_from_urls` in
  `links.rs`, the widget's rows in `widget/summary.rs`, `CommandError` in
  `commands/error.rs`. Code two entries use moves to core: how a client's
  device signals fill the native ones (`domain::device::fill_from_client`),
  how coordinates become place names (`domain::device::place_names`). There
  is no third place in the backend: no `utils/`.
- **One handler list.** Tauri takes a single invoke handler, so `app.rs`
  keeps every command in one `generate_handler!`, by path and grouped by the
  file under `commands/`.
- **Every command refuses with `CommandError`** (`{ kind, message }`). A
  `CoreError` keeps its kind (`stale`, `broken`, `missing`, `notText`), a
  `SyncError` passes its own (`busy`, `notConfigured`, `notAuthenticated`,
  `configCorrupt`, …), anything else is `other`. `broken` means something
  only for a body save. The frontend writes the shape once in
  `lib/commands.ts` and reads the words with `errorText`.

## `tests/screens`

A test tool, not part of the app: the shipped app carries none of it. A Node
package of its own (`tests/screens/package.json`), so its dependencies never
touch the frontend's lockfile or the nix build, and `app/`, the app it drives.

```
tests/screens/
  src/
    shoot/     entry main.ts; scenes.ts, the scene table; still.ts, stopping motion and
               waiting for the page to settle before a shot
    diff/      entry main.ts; pair.ts, which scenes two directories share
    services/  app.ts: the debug app as a process, and its WebDriver session
    utils/     png.ts (pixel count), tree.ts (the accessibility tree and its text),
               order.ts (steps one after another)
  app/         magical-merchant-screens-app: backend's run_with() with the WebDriver server,
               a window nobody resizes, an in-memory keychain and the pinned clock
               (clock.rs); debug builds only
```

- `app/` is a member of the root workspace, like `xtask/`, so `rust::check`
  and `rust::test` cover it. It changes nothing in backend or core: what it
  adds goes in through `run_with()`, and the keychain is swapped in keyring's
  default store before the app starts.
- Each command is its own entry, run by `node` from `tests/screens/justfile`;
  there is no dispatcher.
- Code that runs inside the page (`collectTree`, the callbacks given to
  `browser.execute`) refers to nothing outside itself: WebDriver sends its
  source text.

## `frontend/src`

Things own their rules, their state and their components; only the outside
parties and app-agnostic code are shared.

```
frontend/src/
  main.tsx  capture.tsx  env.d.ts  test-setup.ts  index.css  capture.css  __mocks__/  styles/
  views/       the screens: AppLayout, Scrawl, Workspace (Note / Codex), Browse,
               Templates, CaptureWindow, Settings (+ Settings/ pages)
  <thing>/     note/ codex/ scrawl/ templates/ glyphs/ tags/ search/ browse/
               backlinks/ device/ sync/ editor/ markdown/ shell/ i18n/ theme/
  ui/          components that belong to no thing (Icon, Popover, HoldButton, …)
  services/    one outside party each: backend.ts (Tauri invoke and the wire
               types), window.ts, app.ts, deep-link.ts, geolocation.ts, os.ts,
               local-storage.ts, clipboard.ts, vibration.ts
  utils/       knows nothing about this app: clock, calendar, diff, text,
               debounce, platform, media, …
```

A thing uses the same first-level word as `core/src/domain` where it is the
same thing. It holds:

- **rule files**: pure `.ts`, with no services, no Solid signals and no DOM;
- **state and operation files**: `.ts` that may use services and signals.
  They take their services as parameters, so a test passes a fake instead
  of mocking a module;
- **DOM-attached files** (`<aspect>-view.ts`), only in `editor/`,
  `markdown/` and `shell/`;
- **components**: `.tsx` that render, for that thing only.

Imports:

- `utils/`, `services/` and `ui/` ← things ← `views/`. Nothing outside
  `views/` imports a view.
- `ui/` imports only `utils/` (and i18n's `t()` when it needs words);
  `services/` imports only `utils/`.
- Inside a thing: rule files ← state files ← components. A thing may import
  another thing; a rule file imports only other things' rule files. No
  cycles.
- A rule file may `import type` the wire types from `services/backend.ts`,
  call i18n's `t()` (whose import has no side effect), and read event fields
  or `target.closest()`.
- Views and components may call a service directly. An operation in the
  thing is made only when the call is repeated or carries an app rule.
- Browser APIs that stay inside the page (`matchMedia`, `visualViewport`,
  `Selection`, pointer events) may be used in `utils/`; anything that
  reaches outside the page (storage, clipboard, vibration, battery and
  connection, Tauri) is a service.
- No path aliases.

Names: the thing at the first level, the aspect at the second, in the
product's words. No implementation words, and no `-state` or `-store`
suffix: name what the file holds (`body`, `panel`, `applied`,
`place-names`).
