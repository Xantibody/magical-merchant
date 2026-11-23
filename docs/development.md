# Development

Everything needed to hack on Magical Merchant locally. All commands run
inside the Nix devShell.

## Prerequisites

- [Nix](https://nixos.org/) with Flakes enabled
- [direnv](https://direnv.net/) (recommended)

## Setup

```sh
# 1. Clone and enter the repository
git clone https://github.com/Xantibody/magical-merchant.git
cd magical-merchant

# 2. Allow direnv (loads the Nix devShell automatically)
direnv allow

# 3. Install frontend dependencies
cd frontend && pnpm install && cd ..

# 4. (macOS only) Install Playwright browsers for browser tests
cd frontend && pnpm exec playwright install chromium && cd ..

# 5. Start development
just dev
```

> [!NOTE]
> Without direnv, run `nix develop` to enter the shell manually.

## Browser verification harness

`just frontend::dev-browser` (or `pnpm run dev:browser`) starts Vite with a
Tauri IPC mock injected into `index.html`, so the full UI runs in a plain
browser with deterministic fixtures. Use it for layout/CLS checks and
e2e-style verification (e.g. with `agent-browser`). The mock never reaches
production builds; when adding a Tauri command, add a handler to
`frontend/dev/ipc-mock.js` too — unknown commands throw so the gap is
visible. The recipe passes no arguments through, so a fixed port is
`pnpm run dev:browser --port 5199 --strictPort` from `frontend/`.

The [feature tour](features.md)'s screenshots come from this harness: a wide
window at 1280×800 and a phone at 390×844, with the dark theme and Japanese
pinned through `localStorage` (`theme` = `dark`, `locale` = `ja`) so two
takes can be compared. Retake them when a screen changes shape; the fixture
dates follow today, so every picture of Scrawl moves with the day it is
taken on.

## Sandbox

`just sandbox` runs the real app over `.sandbox/`, a copy of
[`fixtures/`](../fixtures/README.md) — the place to try something on real
files without touching your own notes. The box carries no sync config, so
nothing written there can reach R2, and the app honours the data directory
it is pointed at in debug builds only.

| Command                  | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `just sandbox`           | Start the app over the box, creating it if it is absent |
| `just sandbox-seed`      | Copy `fixtures/` over the box again                     |
| `just sandbox-seed-mine` | Also add your own templates to the box                  |
| `just sandbox-reset`     | Throw the box away                                      |

The recipes are one line each because the work is in `cargo xtask sandbox …`,
where this machine's data directory and the app identifier already have
answers in Rust.

## Screens

`just screens::shoot <dir>` takes every screen of the real app, not the
browser harness: a debug build over a fresh copy of `fixtures/`, driven
through a WebDriver server inside it. For every scene in
`tests/screens/src/shoot/scenes.ts` (the surfaces and states of the UI
Architecture) at each width (wide 1280×800 as in the feature tour, phone
390×844), language and theme, it writes
`<scene>.<width>.<language>.<theme>.png` and `.txt` (the accessibility tree
as text), and a `manifest.json` of what the shots depend on. `<dir>` has to
be new or empty, so no shot from an earlier run passes for this one's.
`just screens::diff <before> <after>` names every scene whose picture or
tree changed, or that only one side has. It exits 0 when nothing differs, 1
when something does, and 2 when it could not compare (an unreadable file,
a scene missing its picture or its tree). Shoot before a change and after
it, then diff.

- The app is `tests/screens/app` (`just screens::app`, run by `shoot`): the
  real app's `run_with()` with a WebDriver server added. The shipped app
  carries none of it, and the crate refuses a release build: the server runs
  whatever script it is sent.
- Every `Date` reads 2026-08-07 12:00 +09:00 (`MAGICAL_MERCHANT_NOW_MS`,
  read by that crate only), so "today" is the same in every take. The time
  zone is the machine's; `manifest.json` records it.
- The window stays on screen while shooting and cannot be resized by hand,
  so a tiling window manager leaves it floating. If something still sizes
  it, `shoot` stops and says so. (A minimized window would stay out of the
  way, but WebKit stops a hidden page's animation frames.)
- Every page the app loads brings the window to the front with the page
  focused, since WebKit shows no focus ring in a page without focus. A shot
  whose page still lacks focus fails rather than differ from the next take.
- The phone is a narrow Mac window. WebKit there still reports a mouse, so
  rules on `hover: none` show their desktop side.
- Shots compare on the machine that took them; fonts and the pixel ratio
  are the machine's.
- The app keeps its sync login in memory (keyring's mock store), never in
  this machine's keychain, so every shoot starts signed out and no keychain
  prompt stops it.
- Stopping `shoot` (Ctrl-C, SIGTERM, SIGHUP) stops the app with it.
- A scene that cannot be reached is listed at the end and fails the run;
  the other scenes keep their shots. `just screens::shoot <dir> --only note`
  takes only the scenes whose name holds `note`.

## DevShell

| Category | Tools                                            |
| -------- | ------------------------------------------------ |
| Rust     | stable toolchain, clippy, rust-analyzer          |
| Frontend | Node.js 22, pnpm, tsc (type check), oxlint       |
| Build    | just, cargo-tauri, go (the Android patchers)     |
| Android  | JDK 17, Android SDK (API 36), NDK 29             |
| Format   | nix fmt (treefmt: nixfmt, rustfmt, taplo, oxfmt) |

`nix develop` also exposes narrower shells so CI (and the release build) only
fetch what they need:

| Shell        | Contents                             | Used by           |
| ------------ | ------------------------------------ | ----------------- |
| `.#default`  | Everything above                     | Local development |
| `.#rust`     | Rust + clippy + just                 | CI (`rust`)       |
| `.#frontend` | Node toolchain + Playwright browsers | CI (`frontend`)   |
| `.#worker`   | Node toolchain                       | CI (`worker`)     |
| `.#screens`  | Node toolchain                       | CI (`screens`)    |
| `.#android`  | `.#default` minus browser automation | Release APK build |

## Task runner (just)

### Root recipes

| Command         | Description                                                        | CI  |
| --------------- | ------------------------------------------------------------------ | --- |
| `just fmt`      | Format all files (`nix fmt`)                                       | ✓   |
| `just check`    | The four module checks + `comments`                                | ✓   |
| `just comments` | Vale (English only, the proper nouns, proselint) and typos         | ✓   |
| `just test`     | `rust::test` + `frontend::test` + `worker::test` + `screens::test` | ✓   |
| `just verify`   | `fmt` → `check` → `test`. Run it before calling something done     |     |
| `just dev`      | `frontend::dev` — the one recipe worth a short name                |     |
| `just sandbox`  | The app over a copy of `fixtures/` (see [Sandbox](#sandbox))       |     |

Everything else is reached through its module — `just frontend::…`,
`just rust::…`, `just android::…`, `just worker::…`, `just screens::…`. Run `just --list <module>` to see them.
CI does not call `verify`; it calls the module recipes directly, in
jobs that a path filter can skip.

### Rust recipes (`rust::`)

| Command                   | Description                                             | CI  |
| ------------------------- | ------------------------------------------------------- | --- |
| `just rust::check`        | `check-rustls`, clippy, `cargo machete`, `cargo deny`   | ✓   |
| `just rust::test`         | `cargo test --workspace`, and `tests/screens/app`       | ✓   |
| `just rust::check-rustls` | Fails unless `Cargo.lock` resolves exactly one `rustls` | ✓   |

Scope a single crate with cargo directly (`cargo test -p magical-merchant-cli`).

`check-rustls` runs first in `rust::check`, and it guards something no test
can: two `rustls` versions make `android_tls`'s `ClientConfig` a different
crate's type from reqwest's. That compiles, and clippy and the test run stay
green on it. Without this recipe the first sign would be a device that fails
every sync with `UnknownPreconfigured`.

### Frontend recipes (`frontend::`)

| Command                      | Description                                        | CI  |
| ---------------------------- | -------------------------------------------------- | --- |
| `just frontend::check`       | oxlint, `tsc -b`, `tsc -p tsconfig.dev.json`, knip | ✓   |
| `just frontend::test`        | Vitest (unit + browser tests)                      | ✓   |
| `just frontend::dev`         | Start Tauri development server                     |     |
| `just frontend::dev-browser` | Vite + IPC mock in a plain browser                 |     |
| `just frontend::build`       | Build macOS .app (Apple Silicon)                   |     |
| `just frontend::icons`       | Regenerate icons from the SVG                      |     |

### Worker recipes (`worker::`)

| Command              | Description         | CI  |
| -------------------- | ------------------- | --- |
| `just worker::check` | oxlint + tsc + knip | ✓   |
| `just worker::test`  | Vitest              | ✓   |

### Screens recipes (`screens::`)

| Command                               | Description                                                                  | CI  |
| ------------------------------------- | ---------------------------------------------------------------------------- | --- |
| `just screens::check`                 | oxlint + tsc + knip                                                          | ✓   |
| `just screens::test`                  | Vitest                                                                       | ✓   |
| `just screens::app`                   | The debug app with the WebDriver server (`tests/screens/app`)                |     |
| `just screens::shoot <dir>`           | Every scene of the real app into `<dir>` (see [Screens](#screens))           |     |
| `just screens::diff <before> <after>` | The scenes that differ; exits 1 when there are any, 2 when it cannot compare |     |

### Android recipes (`android::`)

| Command                           | Description                                         | CI  |
| --------------------------------- | --------------------------------------------------- | --- |
| `just android::init`              | Generate `gen/android` (runs `icons` + the patches) |     |
| `just android::setup`             | Re-apply the TLS + widget patches to `gen/android`  |     |
| `just android::sign-setup`        | Re-inject the signing config into Gradle            |     |
| `just android::dev`               | Development on a connected device                   |     |
| `just android::build-debug`       | Build the debug APK                                 | ✓   |
| `just android::build-release`     | Build a signed release APK                          |     |
| `just android::install [variant]` | Build and install over USB (`debug` / `release`)    |     |

`backend/gen/android/` is generated and gitignored, so everything the
project needs on top of what `tauri android init` writes is re-applied by a
Go program each time. There are three, all idempotent (each strips and
re-inserts its own marked block):

| Patcher                            | What it adds                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `android/tls/apply-tls.go`         | The Kotlin half of `rustls-platform-verifier`, which the sync client currently bypasses    |
| `android/widget/apply-widget.go`   | The widget sources, and the five receivers + two activities + list service in the manifest |
| `android/signing/apply-signing.go` | The release signing config, read from the gitignored `keystore.properties`                 |

`android::setup` runs the first two, on its own from `android::init` and from
both build recipes; `android::sign-setup` runs the third, needs
`keystore.properties`, and so hangs off `android::build-release` only. Call
either by hand after regenerating `gen/android` some other way.

When an Android certificate error turns up, start from the fact that the
verifier those patches wire in is not the one the sync client uses:
`services::android_tls::sync_tls_config` builds a `ClientConfig` over the
`webpki-roots` bundle and `commands/sync/run.rs` hands it to reqwest with
`tls_backend_preconfigured`, so the request is verified against Mozilla's
roots and never asks the device. The platform verifier is still installed and
initialised at startup — the Kotlin component, `services::android_tls::init()` — because
the bypass exists only until `rustls-platform-verifier` stops reporting
Android's "no OCSP responder" as a revoked certificate (upstream #221), and
the wiring has to be there when it does. Anything the device trusts and
Mozilla does not, sync will refuse today.

> [!NOTE]
> **CI column**: ✓ = recipes executed by GitHub Actions (`ci.yml`). CI uses
> path filters to run only the recipes affected by changed files.

## Formatting

`nix fmt` ([treefmt-nix](https://github.com/numtide/treefmt-nix)) provides
unified formatting for all languages. CI runs `nix fmt -- --fail-on-change`.

| Formatter | Target                                                                   |
| --------- | ------------------------------------------------------------------------ |
| nixfmt    | `*.nix`                                                                  |
| rustfmt   | `*.rs`                                                                   |
| taplo     | `*.toml`                                                                 |
| oxfmt     | `*.ts` `*.tsx` `*.js` `*.json` `*.jsonc` `*.css` `*.md` `*.yml` and more |

Markdown included — a docs change that is not formatted fails CI the same
way a source change does.

## Environment variables

| Variable                           | Description                            | Set by       |
| ---------------------------------- | -------------------------------------- | ------------ |
| `MAGICAL_MERCHANT_DATA_DIR`        | Data directory for the CLI / MCP       | User         |
| `MAGICAL_MERCHANT_LOCALE`          | Place-name language for the MCP server | User         |
| `MAGICAL_MERCHANT_ALLOW_WRITE`     | Enable the MCP server's write tools    | User         |
| `VISUAL` / `EDITOR`                | Editor for `magical-merchant edit`     | User         |
| `ANDROID_HOME`                     | Android SDK path                       | Nix devShell |
| `NDK_HOME`                         | Android NDK path                       | Nix devShell |
| `PLAYWRIGHT_BROWSERS_PATH`         | Playwright browser path                | Nix devShell |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | Set to `1` to use Nix-managed browsers | Nix devShell |
