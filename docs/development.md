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
| Frontend | Node.js 22, pnpm, tsgo (type check), oxlint      |
| Build    | just, cargo-tauri, go (Android signing patcher)  |
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

| Command       | Description                         | CI  |
| ------------- | ----------------------------------- | --- |
| `just fmt`    | Format all files (`nix fmt`)        | ✓   |
| `just check`  | Lint + type check (Rust + frontend) | ✓   |
| `just test`   | Run all tests (Rust + frontend)     | ✓   |
| `just verify` | `fmt` → `check` → `test`            |     |
| `just dev`    | Start Tauri development server      |     |

Everything else is reached through its module — `just tauri_app::…`,
`just rust::…`, `just workers::…`. Run `just --list <module>` to see them.

### Rust recipes (`rust::`)

| Command            | Description                        | CI  |
| ------------------ | ---------------------------------- | --- |
| `just rust::check` | `cargo clippy` for all Rust crates | ✓   |
| `just rust::test`  | `cargo test` for all Rust crates   | ✓   |

Scope a single crate with cargo directly (`cargo test -p magical-merchant-cli`).

### Frontend recipes (`tauri_app::`)

| Command                       | Description                        | CI  |
| ----------------------------- | ---------------------------------- | --- |
| `just tauri_app::check`       | oxlint + tsgo type check           | ✓   |
| `just tauri_app::test`        | Vitest (unit + browser tests)      | ✓   |
| `just tauri_app::dev`         | Start Tauri development server     |     |
| `just tauri_app::dev-browser` | Vite + IPC mock in a plain browser |     |
| `just tauri_app::build`       | Build macOS .app (Apple Silicon)   |     |
| `just tauri_app::icons`       | Regenerate icons from the SVG      |     |

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

`android-setup` runs on its own from `android-init` and from both build
recipes; `android-sign-setup` needs `keystore.properties` and so hangs off
`android-build-release` only. Call either by hand after regenerating
`gen/android` some other way.

> [!NOTE]
> **CI column**: ✓ = recipes executed by GitHub Actions (`ci.yml`). CI uses
> path filters to run only the recipes affected by changed files.

## Formatting

`nix fmt` ([treefmt-nix](https://github.com/numtide/treefmt-nix)) provides
unified formatting for all languages. CI runs `nix fmt -- --fail-on-change`.

| Formatter | Target        |
| --------- | ------------- |
| nixfmt    | `*.nix`       |
| rustfmt   | `*.rs`        |
| taplo     | `*.toml`      |
| oxfmt     | `*.js` `*.ts` |

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
