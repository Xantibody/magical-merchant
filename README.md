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

## Development Environment

- **Nix** (devShell) for toolchain management
- **pnpm** for frontend dependency management
- **just** as the task runner (`just check`, `just dev`, `just verify`, etc.)
- Type checking: **tsgo** / Linting: **oxlint** / Formatting: **nix fmt**

## Architecture

- **UI layout**: Header (toggle + mode icon) / Toggle menu (3 modes) / Memo area (full screen) / ActionBar (shown on hover)
- **3 modes**: Timeline / Notes / Tasks
- **Theme**: system / light / dark (syncs with OS setting)
- **Editor principles**: Minimize DOM nodes, localized conversion only, preserve scroll & selection

## Build & Run

```sh
just dev            # Start development server
just check          # Lint + type check
just verify         # Format + check + test
just android-dev    # Development on Android device
```
