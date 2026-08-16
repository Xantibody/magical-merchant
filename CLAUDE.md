# Magical Merchant

A minimal note-taking app: Rust core + Tauri 2 + SolidJS. Two surfaces —
**Timeline** (quick capture journal) and **Notes** (Markdown workspace) —
plus Android home-screen widgets and R2 sync.

## Design Priorities (in order)

1. **Simple UI** — Minimal chrome, full-screen memo area, hidden actions
2. **Lightweight** — Small bundle, fast startup, no unnecessary dependencies
3. **Stylish** — Clean aesthetics with design tokens (Open Props) and Phosphor Icons

Every UI/dependency decision is evaluated against these, in order.
North star: **minimize friction from capture to writing** — the app must be
ready to record the moment it opens (widgets exist for exactly this).

## Tech Stack

| Layer      | Technology                                          |
| ---------- | --------------------------------------------------- |
| Core logic | Rust (`core/` crate, framework-independent)         |
| App        | Tauri 2 + SolidJS (`tauri-app/`)                    |
| Styling    | Open Props via `--app-*` tokens (`styles/base.css`) |
| Icons      | Phosphor Icons (SVG files, `components/Icon.tsx`)   |
| Editor     | Milkdown (headless) + custom plugins                |
| Markdown   | markdown-it + Shiki; Mermaid / markmap lazy         |
| Sync       | Cloudflare Workers + R2 (`workers/`)                |
| AI access  | MCP server (`mcp-cli/`, read-only tools)            |

## UI Architecture (current)

- **Header**: mode tabs (Timeline / Notes) + search field (⌘K palette) +
  calendar jump (Timeline only) + sync + theme cycle + settings
- **Bottom tabs** (mobile): Timeline / Notes / Settings
- **Timeline**: single-column day-grouped journal, time rail, tag filter chips,
  floating capture dock; in-place entry editing; select-mode bulk delete
- **Notes (Workspace)**: list pane + detail pane; mobile shows one pane at a
  time (`workspace--detail`); title field above the body (it _is_ the body's
  leading `# heading`); Milkdown editor is lazy-loaded on first edit;
  per-note mindmap view via frontmatter `view`
- **Command palette** (⌘K): in-memory commands + debounced `search_all`
- **Language**: Japanese and English only, from one table (`lib/i18n.ts`).
  Every user-visible string goes through `t()`; the choice lives in Settings
- There is **no Tasks mode**. Do not add one or reference it.

## Invariants (never break)

- Note **filename is an immutable ID** (`YYYYMMDD_HHMMSS.md`); never rename
- Frontmatter is **preserved verbatim**; any new key must be a typed field on
  `NoteFrontmatter` in Rust core (unknown keys are dropped on save)
- The **editor/preview only ever see the body**, never frontmatter (and never
  the title line — that lives in the title field, `note-title.ts`)
- Sync clients **never upload their own state**; the Worker owns it
- Every new Tauri command gets a handler in `tauri-app/dev/ipc-mock.js`
- Keep the DOM small; never re-render whole documents via innerHTML

## Workflow

- `just dev` — Tauri dev; `just verify` = fmt → check → test (run before done)
- `just tauri_app::dev-browser` — full UI in a plain browser with the IPC mock
  (`BROWSER_MOCK=1`); use it for layout/CLS/e2e-style verification
- Formatting is `nix fmt` (treefmt); CI fails on unformatted files

## Skills (read before touching the area)

| Area                                         | Skill                                  |
| -------------------------------------------- | -------------------------------------- |
| UI components, styling, layout, mobile rules | `.claude/skills/ui-design/SKILL.md`    |
| Milkdown editor, plugins, IME, performance   | `.claude/skills/editor/SKILL.md`       |
| Sync protocol, storage, widgets, deep links  | `.claude/skills/sync-storage/SKILL.md` |
| Rust core, Tauri commands, MCP, testing      | `.claude/skills/rust-core/SKILL.md`    |
