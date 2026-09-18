# Magical Merchant

A minimal note-taking app: Rust core + Tauri 2 + SolidJS. Three surfaces —
**Scrawl** (quick capture journal; route and code still say `timeline`),
**Note** (Markdown workspace; code says `notes`) and **Codex** (a Note that
grows and keeps explicitly committed versions; same `Workspace` view with
`kind="codex"`) — plus Android home-screen widgets and R2 sync.

## Design Priorities (in order)

1. **Simple UI** — Minimal chrome, full-screen memo area, hidden actions
2. **Lightweight** — Small bundle, fast startup, no unnecessary dependencies
3. **Stylish** — Clean aesthetics with design tokens (Open Props) and Phosphor Icons

Every UI/dependency decision is evaluated against these, in order.
North star: **minimize friction from capture to writing** — the app must be
ready to record the moment it opens (widgets exist for exactly this).

## Tech Stack

| Layer      | Technology                                                |
| ---------- | --------------------------------------------------------- |
| Core logic | Rust (`core/` crate, framework-independent)               |
| App        | Tauri 2 + SolidJS (`tauri-app/`)                          |
| Styling    | Open Props via `--app-*` tokens (`styles/base.css`)       |
| Icons      | Phosphor Icons (SVG files, `components/Icon.tsx`)         |
| Editor     | Milkdown (headless) + custom plugins                      |
| Markdown   | markdown-it + Shiki; Mermaid / markmap lazy               |
| Sync       | Cloudflare Workers + R2 (`workers/`)                      |
| CLI / AI   | `cli/`: `$EDITOR` editing + MCP server (`.#cli`, `.#mcp`) |

## UI Architecture (current)

- **Header**: mode tabs (Scrawl / Note / Codex) + search field (⌘K palette) +
  calendar jump (Scrawl only) + sync + settings. The active tab is marked by
  weight alone, never a fill; theme lives in Settings, not the header
- **Shortcuts**: one table in `lib/shortcuts.ts` feeds the key handling, the
  palette's command rows and the `data-key` badges. Holding ⌘ (Ctrl) for 300ms
  floats those badges (`lib/hints.ts`); `?` opens the palette as the list
- **Bottom tabs** (mobile): Scrawl / Note / Codex / Settings
- **Scrawl** (`views/Timeline.tsx`): single-column day-grouped journal, time rail, tag filter chips,
  floating capture dock; in-place entry editing; select-mode bulk delete
- **Note** (`views/Workspace.tsx`): list pane (one line per note) + detail pane; mobile
  shows one pane at a time (`workspace--detail`); title field above the body
  (it _is_ the body's leading `# heading`), then a meta line of created time /
  save state / tags. **There is no edit mode** — the Milkdown editor is open
  from the moment a note is; frontmatter `view` decides the exception
  (`preview` = read-only, `mindmap` = map laid alongside, absent = editable).
  Rare per-note actions live behind one `…` menu (`components/NoteMenu.tsx`)
- **Codex** (`views/Workspace.tsx` with `kind="codex"`, route `/codex`): the
  same view over `data/codex/`. Three things tell it from a Note: the list
  row carries a folded-corner page with the version count (frame darkens when
  the draft has moved on); a **spine** stands to the left of the body
  (`components/VersionSpine.tsx`, 56px of dots while writing, 200px of
  version rows when the history is open; absent on phones); the meta line
  reads "版 4 から +312 B · 9 か月で 4 回刻んだ". The `…` menu adds 版を刻む
  (commits **at once**, no message — the toast summarises and offers undo,
  which deletes the file just written) and 履歴. Opening the history never
  replaces the body: it becomes read-only and each changed block gets a
  `+`/`−` in the gutter (`lib/diff-marks.ts` → `lib/line-marks-markdown.ts`;
  deleted lines are struck through where they used to be). Below 1100px the
  spine stays collapsed and a horizontal card under the title
  (`components/VersionSlider.tsx`) sends versions. Versions are never
  committed automatically. A Note gets "Codex にする" in the same menu; there
  is no way back
- **Command palette** (⌘K): in-memory commands + debounced `search_all`
- **Language**: Japanese and English only, from one table (`lib/i18n.ts`).
  Every user-visible string goes through `t()`; the choice lives in Settings
- There is **no Tasks mode**. Do not add one or reference it.

## Invariants (never break)

- Note **filename is an immutable ID** (`YYYYMMDD_HHMMSS.md`); never rename
- A note's **kind is its directory** (`data/notes/` vs `data/codex/`), never a
  frontmatter key; Note → Codex is a one-way `rename` and the ID stays
- Frontmatter is **preserved verbatim**; any new key must be a typed field on
  `NoteFrontmatter` in Rust core (unknown keys are dropped on save)
- The **editor/preview only ever see the body**, never frontmatter (and never
  the title line — that lives in the title field, `note-title.ts`)
- Sync clients **never upload their own state**; the Worker owns it
- Every **body write goes through core `update_note` with the revision the
  writer read**; a mismatch is refused (`Stale`), never resolved by overwriting
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
