---
name: ui-design
description: UI component patterns, design tokens, layout and mobile conventions for the Tauri app. Use when creating or modifying any UI component, CSS, or view.
---

# UI & Design System

## Tokens — never hardcode

All colors go through the `--app-*` tokens in `styles/base.css` (built on
Open Props, with a dark theme via `:root[data-theme="dark"]`):

- Surfaces: `--app-surface`, `--app-surface-2`, `--app-sidebar`, `--app-input-bg`
- Text: `--app-text`, `--app-text-muted`, `--app-text-faint`, `--app-text-hint`
- Lines: `--app-border` (controls), `--app-hairline` (rails, day separators)
- Accent: `--app-accent`, `--app-accent-soft` (chips, selected rows, focus ring)
- Status: `--app-ok`, `--app-danger`, `--app-undo`, toast pair

Spacing/typography/radius use Open Props (`var(--size-*)`, `var(--radius-*)`,
`var(--font-*)`). New colors: extend the token block, don't inline hex.

## Structural conventions

- One CSS file per surface in `styles/` (timeline.css, workspace.css,
  popover.css, palette.css…); shared primitives live in base.css
  (`.popover`, `.icon-button`, `.button-primary/secondary`)
- Icons: Phosphor SVGs through `<Icon name size />`; register new names in
  `components/Icon.tsx`
- Popovers hang from `.popover-anchor--*` fixed anchors; outside-click closing
  is handled centrally in AppLayout (`closest(".popover, .header-action, …")`)
  — add new trigger classes there or the popover will close on its own button
- Toasts go through `shell.showToast(text, undo?)`; destructive actions get a
  5s undo tombstone (see Workspace.remove) rather than a confirm dialog
- Comments in code explain _why_ (in Japanese, matching the codebase style)

## Layout rules

1. Memo/editor area always occupies the full remaining space
2. Minimal chrome — actions hidden until hover (PC) / revealed on touch
3. Content columns cap at ~640–680px and center
4. Bottom docks (`capture-dock`) float; scroll area pads its bottom so content
   never hides under them

## Mobile (max-width: 767px)

- One pane at a time; `.detail-back` appears; hit targets ≥ 44px
- Safe areas come from `--safe-top` / `--safe-bottom` (set once in base.css —
  never use `env()` directly, tests can't fix it)
- Keyboard: expect the visual viewport to shrink; bottom docks must stay
  visible above the keyboard

## Priority checklist before merging

1. **Simple** — can it be simpler? does it add visible chrome?
2. **Lightweight** — deps, DOM nodes, lazy-load anything heavy
3. **Stylish** — tokens everywhere, intentional spacing
