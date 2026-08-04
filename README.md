<div align="center">
  <img src="tauri-app/src-tauri/icons/icon.svg" width="128" height="128" alt="Magical Merchant">
  <h1>Magical Merchant</h1>
  <p>A minimal note-taking desktop app with a Rust core and a lightweight UI.</p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</div>

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
├── workers/        # Cloudflare Workers (R2 sync backend)
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

## Install

### macOS — Nix (Recommended)

```sh
# Install into your Nix profile (adds /Applications/Nix Apps/Magical Merchant.app)
nix profile install github:Xantibody/magical-merchant

# …or pin a released version
nix profile install github:Xantibody/magical-merchant/v0.1.0

# Update later
nix profile upgrade magical-merchant
```

To build from a local checkout instead:

```sh
nix build .#default
open result/Applications/Magical\ Merchant.app
```

### Android — signed test APK

Releases are side-loaded, not published to the Play Store. Grab the APK from
[Releases](https://github.com/Xantibody/magical-merchant/releases), allow
"install from unknown sources" on the device, and open it. Because every
release is signed with the same key, a new APK installs over the previous one
as an update.

Tagging `vX.Y.Z` (matching `version` in `tauri-app/src-tauri/tauri.conf.json`)
runs `.github/workflows/release.yml`, which builds and attaches the APK. The
workflow needs these repository secrets:

| Secret                      | Value                                            |
| --------------------------- | ------------------------------------------------ |
| `ANDROID_KEYSTORE_BASE64`   | `base64 -i ~/.android-keys/magical-merchant.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password                                |
| `ANDROID_KEY_ALIAS`         | Key alias (e.g. `magical-merchant`)              |
| `ANDROID_KEY_PASSWORD`      | Key password                                     |

See [`tauri-app/android-signing/README.md`](tauri-app/android-signing/README.md)
for creating the keystore and for building locally.

### macOS — nix-darwin module

Add the flake input and enable the module in your nix-darwin configuration:

```nix
# flake.nix
{
  inputs.magical-merchant.url = "github:Xantibody/magical-merchant";

  outputs = { magical-merchant, ... }: {
    darwinConfigurations.myMac = darwin.lib.darwinSystem {
      modules = [
        magical-merchant.darwinModules.default
        {
          services.magical-merchant = {
            enable = true;
            workersUrl = "https://your-worker.example.workers.dev"; # R2 sync URL; must not end with a trailing slash, or sync requests may become `//files`
            autoSync = true; # sync after every successful save
          };
        }
      ];
    };
  };
}
```

The module installs the app to `/Applications/Nix Apps/` and writes a read-only
`sync-config.json` from the options above (the app then hides the Settings
fields it no longer owns).

### macOS — manual build

```sh
# Build the .app bundle
just build

# Copy to Applications
cp -r "target/release/bundle/macos/Magical Merchant.app" /Applications/

# Remove Gatekeeper quarantine (unsigned app)
xattr -cr "/Applications/Magical Merchant.app"
```

## Sync Backend (Cloudflare Workers)

The `workers/` directory contains a Cloudflare Workers backend that syncs data via R2. Authentication uses Google OAuth with self-issued JWTs.

### How sync decides what to do

The Worker owns the sync state. `_sync-state/<user>.json` maps every key to a
content hash and a **server-issued version stamp**; both the Worker and each
client store exactly those values, so change detection never depends on the
filesystem mtime or on a device's clock.

One sync is `GET /sync-state` → local scan → diff → one `POST /sync/bulk`:

| Client sees                        | Action        | Effect on state       |
| ---------------------------------- | ------------- | --------------------- |
| Hash differs from the record       | Upload        | New hash, new stamp   |
| Stamp differs from the record      | Download      | Unchanged             |
| Both differ                        | Conflict      | Local wins, new stamp |
| Gone locally, stamp still matching | Delete remote | Key removed           |
| Gone remotely, hash still matching | Delete local  | (already removed)     |

The client never sends a state of its own: doing so drops keys it has not
downloaded yet, and the next sync would read that as "deleted everywhere" and
erase the notes on every device. Writes use `expected_etag` for compare-and-swap,
and the client retries a losing race automatically.

Turning on **Auto sync** (sync popover, or `autoSync` in the nix-darwin module)
runs a sync a few seconds after any successful write, so a note taken on the
phone reaches the Mac without touching the sync button.

The session JWT lives in the macOS Keychain on desktop. Android has no
Keychain equivalent that `keyring` supports — it silently falls back to an
in-memory store, which loses the token immediately — so on Android the token is
written to the app-private data directory (mode `600`) instead.

On a conflict the local copy wins the key, and the overwritten remote copy is
kept both in R2 under `…​.sync-conflict-<timestamp>.md` and on disk next to the
note. Conflict copies are excluded from scanning, so they never sync back.

### 1. Deploy the Worker

```sh
cd workers
pnpm install
wrangler login
pnpm run deploy:worker
```

> The script is not called `deploy` because `pnpm deploy` resolves to pnpm's
> own workspace command and never runs the script.

### 2. Custom Domain (Optional)

If you want to use a custom domain instead of the default `*.workers.dev` URL:

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → **magical-merchant-sync**
2. **Settings** → **Domains & Routes** → **Add** → **Custom Domain**

### 3. Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. **Google Auth Platform** → **Overview** → Create branding (External, testing mode)
4. **Clients** → **Create OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<your-worker-url>/auth/callback`
5. Copy the Client ID and Client Secret

### 4. Set Secrets

```sh
cd workers

# Google OAuth credentials
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# Random signing key for JWTs (generate with: openssl rand -base64 32)
wrangler secret put JWT_SECRET
```

### 5. Configuration

| Variable               | Location           | Description                      | Default           |
| ---------------------- | ------------------ | -------------------------------- | ----------------- |
| `GOOGLE_CLIENT_ID`     | Secret             | Google OAuth Client ID           | —                 |
| `GOOGLE_CLIENT_SECRET` | Secret             | Google OAuth Client Secret       | —                 |
| `JWT_SECRET`           | Secret             | HMAC-SHA256 signing key for JWTs | —                 |
| `JWT_EXPIRY_SECONDS`   | Secret or `[vars]` | Token lifetime in seconds        | `259200` (3 days) |

### 6. App Configuration

1. Open the app → Settings
2. Enter the Workers URL (e.g., `https://magical-merchant-sync.example.workers.dev`)
3. Click **Login with Google**
4. After authentication, sync is available

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

Communicates via stdio transport and provides the following read-only tools:

| Tool                  | Description                                  |
| --------------------- | -------------------------------------------- |
| `list_notes`          | List all notes with tags and a short preview |
| `read_note`           | Read a note's full Markdown source           |
| `search`              | Search notes and timeline entries            |
| `list_timeline_dates` | List the dates that have timeline entries    |
| `read_timeline`       | Read all timeline entries for a single day   |

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

### Android release recipes (`tauri_app::`)

| Command                                   | Description                              |
| ----------------------------------------- | ---------------------------------------- |
| `just tauri_app::android-sign-setup`      | Re-inject the signing config into Gradle |
| `just tauri_app::android-build-release`   | Build a signed release APK               |
| `just tauri_app::android-install-release` | Build and install it over USB            |

### Rust recipes (`rust::`)

| Command                | Description                          | CI  |
| ---------------------- | ------------------------------------ | --- |
| `just rust::check`     | `cargo clippy` for all Rust crates   | ✓   |
| `just rust::test`      | `cargo test` for all Rust crates     | ✓   |
| `just rust::check-app` | `cargo clippy` for core + app crates |     |
| `just rust::test-app`  | `cargo test` for core + app crates   |     |
| `just rust::check-cli` | `cargo clippy` for mcp-cli crate     |     |
| `just rust::test-cli`  | `cargo test` for mcp-cli crate       |     |

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
