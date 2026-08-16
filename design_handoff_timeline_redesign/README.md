# Handoff: Timeline Redesign (magical-merchant)

## Overview

Redesign of the magical-merchant Tauri app (Solid.js + Cloudflare Workers sync). Adopted direction: **1b "journal flow"** — a single-column, time-rail timeline replacing the current 2-pane list+detail. Covers Timeline, Notes, Settings, command palette, popovers, sync/empty/first-run states, tags, and delete-undo, in light and dark, desktop and mobile.

## About the Design Files

The bundled `Timeline Redesign.dc.html` (+ `Current Timeline.dc.html`, `mm-icon.js`, `assets/regular/*.svg`) are **design references created in HTML** — prototypes showing intended look and behavior, not production code. The task is to **recreate these designs in the existing codebase** (`Xantibody/magical-merchant`, `tauri-app/` — Solid.js, plain CSS with Open Props tokens) using its established patterns: `src/styles/*.css`, `AppLayout.tsx`, `Workspace.tsx`, `Icon.tsx` (Phosphor icons).

## Fidelity

**High-fidelity.** Colors, typography, spacing, and radii are final. Recreate pixel-perfectly, mapping values onto the app's existing `--app-*` / Open Props token system (see Design Tokens).

## Design File Map (section ids inside Timeline Redesign.dc.html)

- `1b` — adopted Timeline (light, desktop + mobile). `1a` is a rejected alternative; ignore.
- `2a` — dark theme of 1b.
- `3a` — Settings (desktop + mobile), command palette, sync popover. (Theme menu removed — see 4a.)
- `4a` — click-to-edit-in-place entry; theme toggle behavior.
- `5a` — Notes tab (desktop 2-pane + mobile list).
- `6a` — sync state popovers, first-run, empty states, calendar jump popover.
- `7a` — tags: inline `#tag` autocomplete + filter chips (desktop + mobile).
- `8a` — delete undo toast; Notes tag chips.

## Screens / Views

### Timeline (1b, adopted)

- **Layout**: single column, `max-width: 680px` centered, top padding 44px, bottom padding 140px (clears floating input). Header bar unchanged in structure (48px, tabs left / search center-right / icon buttons right) but borders lightened to `#f1f3f5`.
- **Day group**: heading row = day label (今日 22px/700; other days 18px/700 `#495057`) + date `13px #868e96` + count right-aligned `12px #ced4da`, tabular-nums. Groups separated by `border-top: 1px solid #f1f3f5; padding-top: 28px`.
- **Entry row**: CSS grid `56px 28px 1fr`.
  - Col 1: time `13px #868e96`, `font-variant-numeric: tabular-nums`, right-aligned. Selected/active entry: `#212529`, weight 600.
  - Col 2: vertical rail — 2px line `#f1f3f5` running full height at `left: 13px`; dot 8px circle, white fill, `2px solid #ced4da` border at `top: 6px`. Active entry dot: 10px solid `#343a40`, no border.
  - Col 3: body `15px / 1.75 #212529`, `padding-bottom: 26px`; metadata line below: 11.5px `#adb5bd`, device icon (laptop/device-mobile 12px) + platform + network.
- **Hover actions** (desktop): small toolbar floats top-right of the row — white bg, `1px solid #f1f3f5`, radius 8px, shadow `0 4px 12px -6px rgba(20,20,25,0.2)`, containing icon buttons (15px icons, 6px padding, radius 6px, `#868e96` → hover `#f1f3f5` bg + `#212529`). Per user decision there is **no promote-to-note action**; toolbar = delete only (edit is click-in-place, see 4a).
- **Floating capture bar**: centered, width 640px, white, `1px solid #e9ecef`, radius 14px, padding `10px 10px 10px 16px`, shadow `0 12px 32px -8px rgba(20,20,25,0.18)`. Textarea borderless 15px/1.5; send button 38×38, bg `#343a40`, radius 10px, white paper-plane-tilt icon, hover `#212529`.
- **Mobile (390px)**: header = large day title (20px/700) + date subline; grid `44px 24px 1fr`; capture bar floats 12px from edges, 64px above bottom tab bar (radius 16px, send 40×40 radius 12). Bottom tabs: Timeline / Notes / Settings, 21px icons, active `#212529` w600, inactive `#adb5bd`.

### Dark theme (2a)

Same geometry. Color swaps: window bg `#212529`; surface-2 `#2b3035`; borders/rail `#343a40` (input border `#495057`); text `#f1f3f5`; muted `#adb5bd`; faint `#868e96`; count/faintest `#495057`; dot border `#868e96`, dot bg = window bg; active dot `#ced4da`; primary button bg `#ced4da` with `#212529` icon (hover `#f1f3f5`); toolbar bg `#2b3035`.

### Click-to-edit in place (4a)

- Body text is `cursor: text`; clicking swaps the row body into an editor card: `border: 1px solid #adb5bd; radius 10px; padding 14px 16px 12px;` focus ring `box-shadow: 0 0 0 3px color-mix(in oklab, #343a40 8%, white)`.
- Footer inside card: hint `クリックでそのまま編集 · Esc で確定` left, save state `✓ 保存しました` right, both 11.5px `#adb5bd`. Autosave on blur/Esc; no explicit save button. Hover toolbar shows delete (+ trash) only.
- **Theme toggle**: no menu. Header icon click cycles ライト → ダーク → システム (sun / moon / circle-half icon reflects current mode); show a small dark tooltip (`#212529` bg, white 11px text, radius 6px) on hover.

### Notes (5a)

- **Desktop**: 2-pane. Left 300px, bg `#fcfcfd`, `border-right: 1px solid #f1f3f5`. Header: `NOTES` label (11px/700 `#adb5bd`, tracking 0.08em) + 新規 button (plus icon, 12px text 600, white bg, `1px solid #e9ecef`, radius 6px). Groups 今週/先週/それ以前 (from `items.ts groupNotes`): 13px/700, current `#212529`, older `#495057`. Note row: radius 8px, padding `8px 10px`; title 13.5px (selected 600), meta 11px `更新日 · filename.md`; selected bg `color-mix(in oklab, #343a40 8%, white)`, hover `#f1f3f5`.
- **Editor pane**: header = filename 13px `#868e96` + `✓ 保存済み` 11.5px `#adb5bd`, trash on right. Content `max-width: 640px` centered, 15px/1.8. Markdown styles (mirror `styles/editor.css`): h1 26px/700/1.25 ls-0.01em, h2 20px/600/1.35, code = ui-monospace 0.9em on `#f1f3f5` radius 4px, blockquote `3px solid #dee2e6` left border, italic `#868e96`, lists `padding-left: 24px`.
- **Mobile**: flat list, title 15px + meta 12px, groups as headers, 新規 = plus icon in header.

### Settings (3a)

- Single centered column `max-width: 560px`, title 22px/700, sections separated by `1px solid #f1f3f5`, section labels `SERVER` / `ACCOUNT` (11px/700 `#adb5bd`, tracking 0.08em).
- Input: `padding 10px 14px; border 1px solid #dee2e6; radius 9px; 14px;` shadow `0 1px 2px rgba(20,20,25,0.04)`.
- Primary button: bg `#343a40`, white text 13px/600, radius 9px, padding `9px 18px`, hover `#212529`. Secondary: white bg, `1px solid #dee2e6`, `#495057` text, hover `#f8f9fa`.
- Auth status: 8px green dot `#2f9e44` + `Authenticated` 13.5px + `· 最終同期 N分前` 12px `#adb5bd`.

### Command palette (3a)

Width 560px, radius 14px, `1px solid #e9ecef`, shadow `0 24px 56px -16px rgba(20,20,25,0.3)`. Input row 15px with esc kbd chip. Sections コマンド / ノート・エントリ (10px/700 `#adb5bd`). Rows: radius 8px, padding `9px 10px`, 14px text, 16px leading icon `#868e96`, date right `11px #ced4da`; selected bg `#f1f3f5`, hover `#f8f9fa`.

### Sync states (3a + 6a)

Popover card: width 264–280px, radius 12px, `1px solid #e9ecef`, shadow `0 12px 32px -12px rgba(20,20,25,0.25)`, padding `14px 16px`.

- **Synced**: green cloud-check `#2f9e44` + すべて同期済み; 最終同期 line; auto-sync toggle (34×20 pill, on = `#343a40`); 今すぐ同期 link (12px underline `#495057`).
- **Offline**: cloud-slash `#868e96`; body 12.5px/1.6 `#868e96`; `未同期: N件 · 最終同期 …` 11.5px `#adb5bd`.
- **Failure**: cloud-warning `#e03131`; error lines verbatim from sync-status (mono 12px on `#f8f9fa` radius 8px); 再試行 secondary button.
- **Conflict copy**: copy icon `#e8590c`; explanation; filename chip mono 12px on `#f8f9fa`; 開いて確認 link.
  Header cloud icon mirrors state (cloud-check / cloud-slash / cloud-warning).

### First-run & empty states (6a)

- **First-run sync card**: 480px, radius 14px, padding `28px 32px`. cloud-check 24px `#868e96`; title 17px/700; body 13.5px/1.7 `#868e96` — states local-only is fine; Workers URL input; 接続 (primary) + あとで (secondary).
- **Empty today**: rail becomes dashed (`repeating-linear-gradient(to bottom, #e9ecef 0 4px, transparent 4px 9px)`), no dot; copy `今日はまだ何も記録していません。` 15px `#adb5bd` + hint 13px `#ced4da`. Yesterday remains below.
- **Empty notes**: note-pencil 24px `#ced4da`, title 15px/600 `#495057`, body 13px `#adb5bd`.

### Calendar jump (6a)

Anchored under header calendar icon. 272px, radius 12px, padding 14px. Month header 13px/600 + caret-left/right buttons. Weekday row 11px `#ced4da`. Day cells 12.5px tabular; other-month `#e9ecef`; no-entry days `#ced4da`; entry days `#212529` with 4px dot `#868e96` below; today = `#343a40` bg, white, radius 6px, 600. Click = jump to that day. Footer hint 11.5px `#adb5bd` above `1px solid #f1f3f5`.

### Tags (7a, 8a)

- **Syntax**: inline `#tag` parsed from body text (timeline entries AND notes). No tag management UI, no frontmatter.
- **Inline render**: `#tag` in body → `#495057` on `#f1f3f5`, radius 5px, padding `1px 5px`, weight 500.
- **Autocomplete**: typing `#` in capture bar opens popup above it (240px, radius 12px, padding 6px, shadow `0 16px 40px -12px rgba(20,20,25,0.28)`): タグ section label; rows = tag + count right (`11px #adb5bd`); last row = `+「#xx」を新規タグとして確定` in `#868e96`. Selected row bg `#f1f3f5`.
- **Filter chips**: row above list (desktop: inside 680px column with `TAGS` label; mobile: horizontal scroll under header). Chip: pill (radius 999px), padding `5px 12px` (mobile `6px 13px`), 12.5px. Inactive: white, `1px solid #e9ecef`, `#495057`. Active: bg `#343a40`, white, 600, with ×. Right side shows `#tag で絞り込み中 · N件`. Frequency-ordered, すべて link to clear.
- **Notes rows**: tag badges after date — 11px, white bg, `1px solid #e9ecef/#f1f3f5`, radius 4px, padding `0 5px`.

### Delete undo (8a)

No confirm dialog. On delete: row is replaced by placeholder (dashed `1px #dee2e6` box, radius 10px, trash icon + `エントリを削除しました` 13px `#adb5bd`; rail dashed). Toast bottom-center: bg `#212529`, white 13.5px, radius 12px, padding `12px 16px`, shadow `0 16px 40px -8px rgba(20,20,25,0.4)`: message + **元に戻す** (700, underline, offset 3px) + divider + × dismiss. Auto-commit after 5s.

## Interactions & Behavior

- Entry click → in-place edit (4a); Esc/blur saves; no edit buttons.
- Delete → placeholder + undo toast, 5s window.
- Theme icon click cycles light → dark → system.
- Calendar day click scrolls timeline to that day.
- `#` in capture input → autocomplete popup; Enter confirms tag; new tags created implicitly.
- Tag chip tap toggles filter; × or すべて clears.
- Hover states throughout: `#f8f9fa` or `#f1f3f5` bg on radius-6/8 elements; icon buttons `#868e96` → `#212529`.
- Capture bar: Enter sends (per existing CaptureBar.tsx behavior), grows with content.

## State Management (additions to existing)

- `editingEntryId: string | null` — in-place edit.
- `pendingDelete: {item, timer} | null` — undo window; delete on expiry.
- `tagFilter: string | null` (or Set) — applies to visible items before grouping.
- `tags` derived: parse `#[\p{L}\p{N}_-]+` from all bodies, count for frequency ordering.
- Sync status enum already exists (`sync-status.ts`) — map to the four popover states.
- Theme: existing `theme.ts` cycle instead of menu.

## Design Tokens

Grayscale (Open Props gray ramp, already in app):

- text `#212529` · body-secondary `#343a40` (also = accent/primary bg) · muted `#495057` · faint `#868e96` · faintest `#adb5bd` · disabled/hint `#ced4da` · border `#dee2e6` · border-light `#e9ecef` · hairline/hover `#f1f3f5` · surface `#f8f9fa` · sidebar `#fcfcfd` · white
- Status: green `#2f9e44`, red `#e03131`, orange `#e8590c`
- Selection bg: `color-mix(in oklab, #343a40 8%, white)` (dark: 8% into `#212529`)
- Radii: 4 (kbd/badges) · 5 (inline tag) · 6 (icon btns, cal cells) · 7 (search) · 8 (list rows) · 9 (inputs/buttons) · 10 (edit card, send) · 12 (popovers, toast) · 14 (capture bar, palette, cards) · 16 (mobile capture) · 999 (chips)
- Shadows: popover `0 12px 32px -12px rgba(20,20,25,0.25)`; palette `0 24px 56px -16px …0.3`; capture `0 12px 32px -8px …0.18`; toast `0 16px 40px -8px …0.4`; input `0 1px 2px …0.04`; focus ring `0 0 0 3px color-mix(in oklab, #343a40 8%, white)`
- Type: system-ui stack (existing `--font-sans`); tabular-nums on all times/dates/counts; mono = ui-monospace for filenames/errors/code
- Dark mappings in 2a section above.

## Assets

Phosphor Icons (regular weight, already the app's icon set via Icon.tsx): lightning, note-pencil, gear, magnifying-glass, calendar-blank, cloud-check, cloud-slash, cloud-warning, cloud-arrow-up, circle-half, sun, moon, pencil, trash, check, x, plus, copy, paper-plane-tilt, laptop, device-mobile, battery-high, wifi-high, caret-left, caret-right. SVGs bundled under `assets/regular/`.

## Files

- `Timeline Redesign.dc.html` — all redesign screens (section ids above)
- `Current Timeline.dc.html` — recreation of the current UI (before reference)
- `mm-icon.js` + `assets/regular/*.svg` — icon loader for the prototypes
- Repo source referenced: `tauri-app/src/views/Workspace.tsx`, `layouts/AppLayout.tsx`, `styles/{base,layout,workspace,popover,settings,palette,editor}.css`, `components/{CaptureBar,CalendarPopover,CommandPalette,SyncPopover,ThemeMenu,Icon}.tsx`, `lib/{items,day-labels,routes,theme,sync-status}.ts`
