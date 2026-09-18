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
cd tauri-app && pnpm install && cd ..

# 4. (macOS only) Install Playwright browsers for browser tests
cd tauri-app && pnpm exec playwright install chromium && cd ..

# 5. Start development
just dev
```

> [!NOTE]
> Without direnv, run `nix develop` to enter the shell manually.

## Browser verification harness

`just tauri_app::dev-browser` (or `pnpm run dev:browser`) starts Vite with a
Tauri IPC mock injected into `index.html`, so the full UI runs in a plain
browser with deterministic fixtures. Use it for layout/CLS checks and
e2e-style verification (e.g. with `agent-browser`). The mock never reaches
production builds; when adding a Tauri command, add a handler to
`tauri-app/dev/ipc-mock.js` too — unknown commands throw so the gap is
visible.

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
| `.#workers`  | Node toolchain                       | CI (`workers`)    |
| `.#android`  | `.#default` minus browser automation | Release APK build |

## Task runner (just)

### Root recipes

| Command       | Description                                                    | CI  |
| ------------- | -------------------------------------------------------------- | --- |
| `just fmt`    | Format all files (`nix fmt`)                                   | ✓   |
| `just check`  | `rust::check` + `tauri_app::check` + `workers::check`          | ✓   |
| `just test`   | `rust::test` + `tauri_app::test` + `workers::test`             | ✓   |
| `just verify` | `fmt` → `check` → `test`. Run it before calling something done |     |
| `just dev`    | `tauri_app::dev` — the one recipe worth a short name           |     |

Everything else is reached through its module — `just tauri_app::…`,
`just rust::…`, `just workers::…`. Run `just --list <module>` to see them.
CI does not call `verify`; it calls the three module recipes directly, in
jobs that a path filter can skip.

### Rust recipes (`rust::`)

| Command                   | Description                                             | CI  |
| ------------------------- | ------------------------------------------------------- | --- |
| `just rust::check`        | `cargo clippy --workspace --all-targets -- -D warnings` | ✓   |
| `just rust::test`         | `cargo test --workspace`                                | ✓   |
| `just rust::check-rustls` | Fails unless `Cargo.lock` resolves exactly one `rustls` | ✓   |

Scope a single crate with cargo directly (`cargo test -p magical-merchant-cli`).

`check-rustls` is not part of `just check`, and it guards something no test
can: two `rustls` versions make `android_tls`'s `ClientConfig` a different
crate's type from reqwest's. That compiles, and clippy and the test run stay
green on it; CI catches it only because this recipe is a step of its own
(`rustls resolves to one version`). Without that step the first sign would be
a device that fails every sync with `UnknownPreconfigured`.

### Frontend recipes (`tauri_app::`)

| Command                       | Description                                        | CI  |
| ----------------------------- | -------------------------------------------------- | --- |
| `just tauri_app::check`       | oxlint, `tsc -b`, `tsc -p tsconfig.dev.json`, knip | ✓   |
| `just tauri_app::test`        | Vitest (unit + browser tests)                      | ✓   |
| `just tauri_app::dev`         | Start Tauri development server                     |     |
| `just tauri_app::dev-browser` | Vite + IPC mock in a plain browser                 |     |
| `just tauri_app::build`       | Build macOS .app (Apple Silicon)                   |     |
| `just tauri_app::icons`       | Regenerate icons from the SVG                      |     |

### Worker recipes (`workers::`)

| Command               | Description         | CI  |
| --------------------- | ------------------- | --- |
| `just workers::check` | oxlint + tsc + knip | ✓   |
| `just workers::test`  | Vitest              | ✓   |

### Android recipes (`tauri_app::`)

| Command                                     | Description                                         | CI  |
| ------------------------------------------- | --------------------------------------------------- | --- |
| `just tauri_app::android-init`              | Generate `gen/android` (runs `icons` + the patches) |     |
| `just tauri_app::android-setup`             | Re-apply the TLS + widget patches to `gen/android`  |     |
| `just tauri_app::android-sign-setup`        | Re-inject the signing config into Gradle            |     |
| `just tauri_app::android-dev`               | Development on a connected device                   |     |
| `just tauri_app::android-build-debug`       | Build the debug APK                                 | ✓   |
| `just tauri_app::android-build-release`     | Build a signed release APK                          |     |
| `just tauri_app::android-install [variant]` | Build and install over USB (`debug` / `release`)    |     |

`src-tauri/gen/android/` is generated and gitignored, so everything the
project needs on top of what `tauri android init` writes is re-applied by a
Go program each time. There are three, all idempotent (each strips and
re-inserts its own marked block):

| Patcher                            | What it adds                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `android-tls/apply-tls.go`         | The Kotlin half of `rustls-platform-verifier`, which the sync client currently bypasses      |
| `android-widget/apply-widget.go`   | The widget sources, and the four receivers + capture activity + list service in the manifest |
| `android-signing/apply-signing.go` | The release signing config, read from the gitignored `keystore.properties`                   |

`android-setup` runs the first two, on its own from `android-init` and from
both build recipes; `android-sign-setup` runs the third, needs
`keystore.properties`, and so hangs off `android-build-release` only. Call
either by hand after regenerating `gen/android` some other way.

When an Android certificate error turns up, start from the fact that the
verifier those patches wire in is not the one the sync client uses:
`android_tls::sync_tls_config` builds a `ClientConfig` over the
`webpki-roots` bundle and `sync.rs` hands it to reqwest with
`tls_backend_preconfigured`, so the request is verified against Mozilla's
roots and never asks the device. The platform verifier is still installed and
initialised at startup — the Kotlin component, `android_tls::init()` — because
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
