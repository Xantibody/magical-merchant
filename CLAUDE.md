# Magical Merchant

A minimal note-taking app: Rust core + Tauri 2 + SolidJS. Three surfaces —
**Scrawl** (quick capture journal),
**Note** (Markdown workspace; code says `notes`) and **Codex** (a Note that
grows and keeps explicitly committed versions; same `Workspace` view with
`kind="codex"`) — plus Android home-screen widgets and R2 sync.

Everything a record can live in is one of those three. **Browse** (`絞る`,
⌘F, `/browse`) is not a fourth: it is one screen that looks _across_ the three
by kind / tag / period, and every row it lists sends you back to the surface
the record lives on. Settings and Templates are screens in the same sense.

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

- **Rail** (`components/Rail.tsx`, desktop only): a 48px column down the left
  edge — Scrawl / Note / Codex, a divider, then 検索 (⌘K) · 絞る (⌘F) ·
  (pushed to the foot) 同期 · 設定 (⌘,). It carries no words; the names are in
  `title` and for the screen reader. Where you are is said twice: the button is
  filled (`--app-accent-soft`) and a 2×20px line slides down the left edge
  (`--app-ease`, 220ms) between the three surfaces. 絞る and 設定 are not
  surfaces, so the line goes out rather than sliding to them
- **List flyout** (`views/Workspace.tsx` + `styles/workspace.css`, Note / Codex
  on desktop): 280px that floats **over** the body while the pointer is on the
  rail or on itself — the body column does not move when it opens. A pin, and
  ⌘\, keep it out. Below 768px it is the full page it always was
- **Bottom bar** (30px, desktop only, `layouts/AppLayout.tsx`): where the save
  landed, and nothing else. No current location — the rail's line and the title
  already say it. A phone gets no bar (it would stack with the tabs); there the
  save state lives in the note's meta line
- **Mobile**: a 48px header (back · title · Scrawl's calendar · search · sync)
  and four bottom tabs — Scrawl / Note / Codex / Settings
- **Shortcuts**: one table in `lib/shortcuts.ts` feeds the key handling, the
  palette's command rows and the `data-hint-key` badges. Holding ⌘ (Ctrl) for
  300ms floats those badges (`lib/hints.ts`); `?` opens the palette as the
  list. A badge goes on every **visible** control whose key works right now —
  the rail's seven, 新規 and the list's pin, `…`, 履歴. Keys that only exist
  inside the `…` menu are spelled on the row instead. The attribute is
  `data-hint-key`, not `data-key`, because Kobalte writes `data-key` on the
  rows of its own collections
- **Scrawl** (`views/Scrawl.tsx`): single-column day-grouped journal, time rail,
  floating capture dock; in-place entry editing; select-mode bulk delete. The
  tag chips at the top do not filter in place — they open Browse with Scrawl
  and that tag already chosen
- **Note** (`views/Workspace.tsx`): list flyout + detail pane; mobile shows one
  pane at a time (`workspace--detail`); title field above the body
  (it _is_ the body's leading `# heading`), then a meta line of created time /
  save state / tags. **There is no edit mode** — the Milkdown editor is open
  from the moment a note is; frontmatter `view` decides the exception
  (`preview` = read-only, `mindmap` = map laid alongside, absent = editable).
  Rare per-note actions live behind one `…` menu (`components/NoteMenu.tsx`,
  Kobalte `DropdownMenu`)
- **Codex** (`views/Workspace.tsx` with `kind="codex"`, route `/codex`): the
  same view over `data/codex/`. Three things tell it from a Note: the list row
  carries a folded-corner page with the version count (frame darkens when the
  draft has moved on); the meta line reads "版 4 から +312 B · 9 か月で 4 回
  刻んだ"; and a **history panel** (`components/HistoryPanel.tsx`) stands at the
  right edge, 320px, opened by the 履歴 button / ⌘⇧H / folded by the same, Esc
  or ×. It never opens on hover — 320px must not appear beside a writing hand
  in passing. 版を刻む is in the `…` menu (commits **at once**, no message —
  the toast summarises and offers undo, which deletes the file just written).
  Opening the history never replaces the body: it becomes read-only and each
  changed block gets a `+`/`−` and a 10% tint in the gutter
  (`lib/diff-marks.ts` → `lib/line-marks-markdown.ts`; deleted lines are struck
  through where they used to be). On a phone the history is its own screen and
  a compare bar sits under the body. Versions are never committed
  automatically. A Note gets "Codex にする" in the same menu; there is no way
  back
- **Browse** (`views/Browse.tsx`, `lib/browse.ts`, ⌘F): kind / tag / period
  chips with counts (240px) → the matching records, newest first → the one
  selected, in full. **It has no text search** — typing to find something is
  ⌘K's job. It reads every record once through core `browse_all` and counts the
  facets in TS, because a facet's count is taken over the _other_ axes
  (#279). A phone drops the preview column
- **Command palette** (⌘K): in-memory commands + debounced `search_all`
- **Popovers close themselves** (`components/Popover.tsx`, corvu `Dialog` with
  `modal={false}`). There is no central outside-click handler in `AppLayout`
- **Motion**: transform and opacity, 120–350ms, one easing (`--app-ease`), and
  two keyframes — `mm-rise` (menus, palette, pages, the restore button) and
  `mm-pop` (a version just committed). `styles/motion.test.ts` reads every
  stylesheet and names whatever drifts out, including the two animations kept
  as exceptions
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
- **Kobalte (`@kobalte/core`) is imported only from a lazy route chunk**
  (`Workspace`, `Settings`). Its first component drags in ~27 KB gzip of shared
  base; one import from `AppLayout` or any eager module puts that in the
  startup bundle and roughly doubles it. corvu (~10 KB) is the eager-side
  counterpart. Measure the gzipped `assets/index-*.js` + `web-*.js` after
  `pnpm build` before adding either
- **Scrawl / Note / Codex are proper nouns**, and nothing spells them any other
  way — strings in both languages, `widget_strings.xml`, docs, MCP tools, the
  CLI subcommand, modules, files, types, CSS classes, `data/scrawl/`. Only the
  `/` route still reads as the old name, and a path has no word in it.
  `i18n.test.ts` fails on a translated name
- A tree written before the rename carries `data/timeline/`. **Every entry that
  can write a day file migrates it first** (`migrate_scrawl_dir`, called from
  the sync lock, app start, CLI start and the widget's JNI) — after the scan it
  would be too late, and the sync would carry both spellings
- Keep the DOM small; never re-render whole documents via innerHTML

## Workflow

- `just dev` — Tauri dev; `just verify` = fmt → check → test (run before done)
- `just tauri_app::dev-browser` — full UI in a plain browser with the IPC mock
  (`BROWSER_MOCK=1`); use it for layout/CLS/e2e-style verification. It passes
  no arguments through, so a fixed port means calling
  `pnpm run dev:browser --port N --strictPort` from `tauri-app/` instead
- Formatting is `nix fmt` (treefmt); CI fails on unformatted files

## Skills (read before touching the area)

| Area                                         | Skill                                  |
| -------------------------------------------- | -------------------------------------- |
| UI components, styling, layout, mobile rules | `.claude/skills/ui-design/SKILL.md`    |
| Milkdown editor, plugins, IME, performance   | `.claude/skills/editor/SKILL.md`       |
| Sync protocol, storage, widgets, deep links  | `.claude/skills/sync-storage/SKILL.md` |
| Rust core, Tauri commands, MCP, testing      | `.claude/skills/rust-core/SKILL.md`    |
