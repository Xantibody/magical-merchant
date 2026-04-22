# Magical Merchant

A minimal note-taking desktop app with a Rust core and a lightweight UI.

## Tech Stack

| Layer              | Technology                               |
| ------------------ | ---------------------------------------- |
| Core logic         | Rust (`core/` crate)                     |
| Desktop app        | Tauri 2 + SolidJS                        |
| Styling            | Open Props (CSS custom properties)       |
| Icons              | Phosphor Icons (SVG files)               |
| Editor             | Milkdown (headless, SolidJS integration) |
| Code highlighting  | `@milkdown/plugin-highlight` + Shiki     |
| Markdown rendering | markdown-it + Shiki                      |

## Project Structure

```
magical-merchant/
├── core/           # Rust core library (framework-independent business logic)
├── mcp-cli/        # MCP server CLI (exposes core as AI assistant tools)
├── tauri-app/
│   ├── src/        # SolidJS frontend (TypeScript)
│   └── src-tauri/  # Tauri 2 backend (Rust)
├── rust/           # Shared Rust just recipes
├── nix/            # Nix configuration helpers
└── plans/          # Implementation plans
```

## Getting Started

### Prerequisites

- [Nix](https://nixos.org/) with Flakes enabled
- [direnv](https://direnv.net/) (recommended)

### Setup

```sh
# 1. Clone and enter the repository
git clone https://github.com/Xantibody/magical-merchant.git
cd magical-merchant

# 2. Allow direnv (loads Nix devShell automatically)
direnv allow

# 3. Install frontend dependencies
cd tauri-app && pnpm install && cd ..

# 4. (macOS only) Install Playwright browsers for browser tests
cd tauri-app && pnpm exec playwright install chromium && cd ..

# 5. Start development
just dev
```

> Without direnv, run `nix develop` to enter the shell manually.

### Tools provided by DevShell

| Category | Tools                                            |
| -------- | ------------------------------------------------ |
| Rust     | stable toolchain, clippy, rust-analyzer          |
| Frontend | Node.js 22, pnpm, tsgo (type check), oxlint      |
| Build    | just, cargo-tauri                                |
| Android  | JDK 17, Android SDK (API 36), NDK 29             |
| Format   | nix fmt (treefmt: nixfmt, rustfmt, taplo, oxfmt) |

## Build & Install (macOS)

```sh
# Build the .app bundle (Apple Silicon)
just build

# Copy to Applications
cp -r "target/release/bundle/macos/Magical Merchant.app" /Applications/

# Remove Gatekeeper quarantine (unsigned app)
xattr -cr "/Applications/Magical Merchant.app"
```

## Environment Variables

| Variable                           | Description                            | Set by       |
| ---------------------------------- | -------------------------------------- | ------------ |
| `MAGICAL_MERCHANT_DATA_DIR`        | Data directory path for MCP CLI        | User         |
| `ANDROID_HOME`                     | Android SDK path                       | Nix devShell |
| `NDK_HOME`                         | Android NDK path                       | Nix devShell |
| `PLAYWRIGHT_BROWSERS_PATH`         | Playwright browser path                | Nix devShell |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | Set to `1` to use Nix-managed browsers | Nix devShell |

## MCP CLI

`mcp-cli/` is a [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the core library as tools for AI assistants.

```sh
magical_merchant_mcp_cli --data-dir /path/to/data
```

Communicates via stdio transport and provides the following tools:

| Tool                   | Description                              |
| ---------------------- | ---------------------------------------- |
| `list_projects`        | List all projects                        |
| `list_active_tasks`    | List active tasks for a project          |
| `list_completed_tasks` | List completed tasks for a project       |
| `get_task_history`     | Get completed task history by date range |

## Task Runner (just)

[just](https://github.com/casey/just) is the task runner. Run all commands inside the `nix develop` shell.

### Root recipes

| Command              | Description                         | CI  |
| -------------------- | ----------------------------------- | --- |
| `just fmt`           | Format all files (`nix fmt`)        | ✓   |
| `just check`         | Lint + type check (Rust + frontend) | ✓   |
| `just test`          | Run all tests (Rust + frontend)     | ✓   |
| `just verify`        | `fmt` → `check` → `test`            |     |
| `just dev`           | Start Tauri development server      |     |
| `just android-init`  | Initialize Android target           |     |
| `just android-dev`   | Development on Android device       |     |
| `just android-build` | Build Android APK                   |     |
| `just build`         | Build macOS .app (Apple Silicon)    |     |

### Rust recipes (`rust::`)

| Command                 | Description                          | CI  |
| ----------------------- | ------------------------------------ | --- |
| `just rust::check`      | `cargo clippy` for all Rust crates   |     |
| `just rust::test`       | `cargo test` for all Rust crates     |     |
| `just rust::check-core` | `cargo clippy` for core + app crates | ✓   |
| `just rust::test-core`  | `cargo test` for core + app crates   | ✓   |
| `just rust::check-cli`  | `cargo clippy` for mcp-cli crate     | ✓   |
| `just rust::test-cli`   | `cargo test` for mcp-cli crate       | ✓   |

### Frontend recipes (`tauri_app::`)

| Command                 | Description                    | CI  |
| ----------------------- | ------------------------------ | --- |
| `just tauri_app::check` | oxlint + tsgo type check       | ✓   |
| `just tauri_app::test`  | Vitest (unit + browser tests)  | ✓   |
| `just tauri_app::dev`   | Start Tauri development server |     |

> **CI column**: ✓ = Recipes executed by GitHub Actions (`ci.yml`).
> CI uses path filters to run only the recipes affected by changed files.

## Formatting

`nix fmt` ([treefmt-nix](https://github.com/numtide/treefmt-nix)) provides unified formatting for all languages.

| Formatter | Target        |
| --------- | ------------- |
| nixfmt    | `*.nix`       |
| rustfmt   | `*.rs`        |
| taplo     | `*.toml`      |
| oxfmt     | `*.js` `*.ts` |

CI runs `nix fmt -- --fail-on-change` to verify formatting.
