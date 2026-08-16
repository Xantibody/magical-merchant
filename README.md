<div align="center">
  <img src="tauri-app/src-tauri/icons/icon.svg" width="128" height="128" alt="Magical Merchant">
  <h1>Magical Merchant</h1>
  <p>A local-first journal and Markdown workspace — quick capture on a timeline, notes that grow out of it. Rust core, Tauri 2 + SolidJS, minimal UI.</p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</div>

![Timeline](docs/images/timeline.png)

## Features

- **Timeline journal** — a day-grouped capture log with tags, device/place
  context, a calendar jump, and a weekly digest (including _one year ago
  today_)
- **Markdown notes** — a Typora-style Milkdown editor; a title field that is
  the body's own `# heading`, tap anywhere in the preview to edit, autosave
  with a local one-step revert, Shiki code highlighting, Mermaid diagrams,
  and a per-note mindmap view
- **Entries grow into notes** — promote a timeline entry into a note; the two
  stay linked through the note's `origin` frontmatter
- **`[[links]]` and backlinks** — link notes by immutable file ID with
  autocomplete, optionally with `|display text`; every note lists the records
  that point at it
- **`⌘K` palette** — recent notes / today / tags before you type, full-text
  search with highlighted matches, exact landing on the note or day
- **Optional sync** — Cloudflare Workers + R2, conflict-safe, with Android
  home-screen widgets and a read-only MCP server for AI assistants

Everything is a plain Markdown file on disk. See the
**[feature tour](docs/features.md)** for screenshots of each surface.

## Quick Start

```sh
# Install on macOS (Nix)
nix profile install github:Xantibody/magical-merchant
```

```sh
# Develop
git clone https://github.com/Xantibody/magical-merchant.git
cd magical-merchant
direnv allow                       # or: nix develop
cd tauri-app && pnpm install && cd ..
just dev
```

More options (nix-darwin module, manual build, Android APK) are in
[docs/install.md](docs/install.md).

## Documentation

| Page                                 | Contents                                                |
| ------------------------------------ | ------------------------------------------------------- |
| [Feature tour](docs/features.md)     | Every surface, with screenshots                         |
| [Architecture](docs/introduction.md) | System overview, design decisions, data flow            |
| [Development](docs/development.md)   | DevShell, task runner, browser harness, formatting      |
| [Install](docs/install.md)           | macOS (Nix / nix-darwin / manual), Android APK, widgets |
| [Sync backend](docs/sync.md)         | Worker + R2 deployment and the sync protocol            |

## Tech Stack

Rust core (`core/`) shared by the Tauri 2 app, an MCP server (`mcp-cli/`),
and benchmarks · SolidJS + Milkdown frontend · Open Props design tokens ·
Cloudflare Workers + R2 sync (`workers/`) · Nix flake for dev/CI/packaging.

```
magical-merchant/
├── core/           # Rust core library (framework-independent business logic)
├── mcp-cli/        # MCP server CLI (exposes core as AI assistant tools)
├── tauri-app/
│   ├── src/        # SolidJS frontend (TypeScript)
│   └── src-tauri/  # Tauri 2 backend (Rust)
├── workers/        # Cloudflare Workers (R2 sync backend)
├── docs/           # Documentation
├── rust/           # Shared Rust just recipes
└── nix/            # Nix configuration helpers
```
