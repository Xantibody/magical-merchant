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

- **One way to each thing**: a place is changed in one spot, a record is made from one
  control, search has one field per screen. Before adding an entry point, find the one that
  already does the job
- **Wide window (≥768px)**: a 64px **rail** of icons at the left edge
  (`components/Library.tsx`, `styles/library.css`): the status line at its top, and at its
  foot the four places (Scrawl · Note · Codex · 絞る), the search and the ring's +. It never
  folds or opens out; a name shows beside its icon on hover and focus. On Note / Codex the
  **list** (`components/NoteList.tsx`, 280px) stands beside the page, and the one grip on the
  page's left edge (`components/SheetGrip.tsx`) or ⌘\ tucks it under the page and brings it
  back (`shell.listTucked`, remembered). A page with no list beside it has no grip
- **Phone (<768px)**: no header and no shelf; everything pressed is at the foot
  (`styles/palm.css`, `styles/reach.css`). Bottom-left, the **place pill**
  (`components/PlaceSwitch.tsx`): Scrawl · Note · Codex, always at the same spot; on Scrawl it
  stretches to hold the input field. Bottom-right, the page's one round button: + on a list,
  the pencil (with `…` for the note's sheet) on a note. On a level (a note, a Settings page) a
  round back button stands after the pill. Browse, Settings and Templates are reached from the
  empty search field. Reading down folds the bar to one line of words (`lib/slim.ts`)
- **Built from the foot**: Note / Codex lists and the search field's results rest on their
  foot (`data-foot`, `lib/foot.ts`), newest nearest the thumb, with the page's name and its
  探す field under them. Scrawl is the exception: it reads newest first from the top
- **The ring** (`components/Ring.tsx`, `lib/ring.ts`): pressing a + (or holding the pill) opens a
  fan of labelled pills out of it — Scrawl に 1 行 · Note を作る · Codex を作る · テンプレートから. Slide
  onto one and let go, or let go first and tap. It is the one way to make a record from
  anywhere
- **Gestures** (`lib/gesture.ts` decides, `lib/palm-gestures.ts` acts): a stroke to the right
  goes one level back (nothing at the top of a surface), a stroke to the left opens a row's
  actions, up on the bar raises the note's sheet. Android's back peels the same layers
  (`lib/system-back.ts`). Every stroke has a visible control that does the same
- **Status** (`components/StatusDot.tsx`, `styles/status-dot.css`): green (saved, synced), grey
  (saving or syncing), red (a failed save or sync, a lost login); a device never set up stays
  green. A wide window says it in words at the top of the rail, a phone as one dot in the top
  right corner. Pressing either opens the details (`SyncPopover` + `StatusDetails`): the save
  time, and for the open note the version, 比較中, every view state that is **on**
  (pressing one docks the note panel on its switch), 版を刻む and 編集前に戻す
  when they would do something, then the sync, and at the foot Scrawl · 検索 · Settings · キー.
  Workspace hands the note's part over through the shell (`noteState`), like the save state.
  Only a failure interrupts, with a toast (`syncAlertText`)
- **Shortcuts**: one table in `lib/shortcuts.ts` feeds the key handling, the
  palette's command rows and the `data-hint-key` badges. Holding ⌘ (Ctrl) for
  300ms floats those badges (`lib/hints.ts`); `?` opens the palette as the
  list. A badge goes on every **visible** control whose key works right now —
  the rail's places and its search, the list's grip, 新規, the note panel's `…` and its
  履歴 tab, the status details' two actions. Keys that only exist inside the note
  panel are spelled on the row instead. The attribute is
  `data-hint-key`, not `data-key`, because Kobalte writes `data-key` on the
  rows of its own collections
- **Scrawl** (`views/Scrawl.tsx`): single-column day-grouped journal, time rail,
  newest first (today at the top, as a feed reads). The input field is at the foot on both
  widths: the end of the sheet on a wide window, inside the place pill on a phone. Just over
  it, a band: the week's line, the tag chips, the calendar. A thumb on the right edge
  (`components/ScrawlScrubber.tsx`) scrubs through the days; records are read-only, and the one thing a record
  leads to is a Note made from it (asked first); select-mode bulk delete. Notes
  and Codexes sit among the entries (`lib/scrawl-days.ts`) as a filled dot and a
  bold title, unless the chip under their origin entry already leads to them. The
  band's tag chips do not filter in place — they open the search field
  with that tag, or, while a line is being typed, join the line. The input line's `/` menu (探す · Note を作る · 日付へ) is the
  line's way to search; it answers to row names only, so `/tmp` stays a record
- **Note** (`views/Workspace.tsx`): the list beside the page + detail pane; mobile shows one
  pane at a time (`workspace--detail`); a note opens in the
  **viewer** (`MarkdownPreview`, the title as a heading, a meta line of created
  time and tags that only shows them, a body `#tag` outlined, then the records
  pointing here). Enter, e, a double click or the pencil in the strip over the page
  open the **writing screen** (the Milkdown editor under a title field that _is_
  the body's leading `# heading`); Esc or the check come back. The writing
  screen shows no meta line and has no way into the note panel. The URL carries it
  (`edit=1`), and what was just made opens there (`writeRoute`). A note chosen
  from the list opens in the viewer. Frontmatter `view: mindmap` lays the map
  alongside; `preview` stays in the file and now means nothing more than the
  default. Everything per-note lives in the **note panel**
  (`components/NotePanel.tsx`, `styles/note-panel.css`): 320px at the right
  edge — the view switches, the tags (`components/TagEditor.tsx`: chips,
  suggestions counted in core by `count_tags`, a body `#tag` has no ×), 詳細 (created
  time editable, updated, surroundings),
  revert / Codex にする / delete (the last two are a held press, `HoldButton.tsx`). The `…`
  in the viewer's strip and ⌘. are the only ways in, and the body gives up 320px
  while it is open. Open is the app's state (`shell.notePanelPinned`), not the
  note's. Esc peels one layer: tag input → history; the settings tab
  stays. On a phone it is a sheet that rises from the foot (the `…` beside the
  pencil, or a push up on the bar)
- **Codex** (`views/Workspace.tsx` with `kind="codex"`, route `/codex`): the
  same view over `data/codex/`. Three things tell it from a Note: the list row
  carries a folded-corner page with the version count (frame darkens when the
  draft has moved on); the viewer's meta line reads "版 4 から +312 B"; and the note
  panel gets a second tab, **履歴** (`components/HistoryPanel.tsx` is its body,
  topped by "9 か月で 4 回刻んだ"). The tab and ⌘⇧H open it; the panel always
  opens on the first tab. The history tab _is_ compare mode
  (`historyOpen`). 版を刻む is in the panel and the status details (commits **at once**,
  no message — the toast summarises and offers undo, which deletes the file
  just written).
  Opening the history never replaces the body: it stays read and each
  changed block gets a `+`/`−` and a 10% tint in the gutter
  (`lib/diff-marks.ts` → `lib/line-marks-markdown.ts`; deleted lines are struck
  through where they used to be). On a phone the history is the panel
  screen's second tab and a compare bar sits under the body. Versions are
  never committed automatically. A Note gets "Codex にする" in the same panel;
  there is no way back
- **Browse** (`views/Browse.tsx`, `lib/browse.ts`, ⌘F): kind / tag / period
  chips with counts (240px) → the matching records, newest first → the one
  selected, in full. **It has no text search** — typing to find something is
  the search field's job. It reads every record once through core `browse_all` and counts the
  facets in TS, because a facet's count is taken over the _other_ axes
  (#279). A phone drops the preview column
- **Search field** (`components/SearchField.tsx`, `lib/search-condition.ts`, ⌘K,
  `/ 探す`, typing on Scrawl and Browse): hidden until called, floats over the route
  inside `app-main` so an open note stays mounted, Esc gives the keys back. It
  opens on the chips and the newest 20 records (`browse_all`), and any condition
  lists on its own through core `search_records`, whose kind and period run before
  the 100 cap. Tags are AND here, OR in Browse (ADR 0015). The only
  thing a result does is open. Commands answer a bare word, above the records,
  and the empty field lists the places (Scrawl · Note · Codex · 絞る · 設定);
  Enter stays on the first record
- **Command palette** (`?`): the key list, with in-memory commands + debounced
  `search_all`
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
  the sync lock, app start, the widget's read and core `save_entry`) — after the
  scan it would be too late, and the sync would carry both spellings. A command
  that only reads never migrates, so a read-only MCP stays read-only
- Keep the DOM small; never re-render whole documents via innerHTML

## Workflow

- `just dev` — Tauri dev; `just verify` = fmt → check → test (run before done)
- `just tauri_app::dev-browser` — full UI in a plain browser with the IPC mock
  (`BROWSER_MOCK=1`); use it for layout/CLS/e2e-style verification. It passes
  no arguments through, so a fixed port means calling
  `pnpm run dev:browser --port N --strictPort` from `tauri-app/` instead
- `just sandbox` — the real app over `.sandbox/`, a copy of `fixtures/`. Use it
  for anything that has to be tried on real data without touching your own
  notes; `sandbox-seed` re-copies, `sandbox-seed-mine` adds your own templates,
  `sandbox-reset` throws the box away. The recipes are one line each because
  the work is in `cargo xtask sandbox …` — where this machine's data directory
  and the app identifier already have answers, in Rust. The app honours
  `MAGICAL_MERCHANT_DATA_DIR` in debug builds only (`app_base_dir`), and the box
  carries no sync config, so nothing written there can reach R2
- `fixtures/` is committed, English and immutable — one of every surface, read
  through the core by `core/tests/fixtures.rs` on every run, so a format change
  cannot quietly leave it behind. Never copy personal notes into it
- Formatting is `nix fmt` (treefmt); CI fails on unformatted files
- **Source comments are English.** Their reader is an AI session, and one
  language keeps the terms greppable; Japanese belongs in string tables, never
  in a comment. `just comments` runs Vale (`.vale.ini`: no Japanese, the proper
  nouns, proselint) and typos over the tree; CI runs it on the files a PR
  touches, so editing a file that still carries Japanese comments means
  translating them in the same change

## Skills (read before touching the area)

| Area                                         | Skill                                  |
| -------------------------------------------- | -------------------------------------- |
| UI components, styling, layout, mobile rules | `.claude/skills/ui-design/SKILL.md`    |
| Milkdown editor, plugins, IME, performance   | `.claude/skills/editor/SKILL.md`       |
| Sync protocol, storage, widgets, deep links  | `.claude/skills/sync-storage/SKILL.md` |
| Rust core, Tauri commands, MCP, testing      | `.claude/skills/rust-core/SKILL.md`    |
