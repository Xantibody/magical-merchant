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

- One CSS file per surface in `styles/` (scrawl.css, workspace.css,
  popover.css, palette.css…); shared primitives live in base.css
  (`.popover`, `.icon-button`, `.button-primary/secondary`)
- Icons: Phosphor SVGs through `<Icon name size />`; register new names in
  `components/Icon.tsx`
- Popovers hang from `.popover-anchor--*` fixed anchors and **close
  themselves**: wrap the panel in `components/Popover.tsx` (corvu `Dialog`,
  `modal={false}`) and hand `shell.togglePopover(name, e.currentTarget)` the
  button. AppLayout has no central outside-click handler any more. Forget the
  trigger element and the popover folds on its own button — the pointerdown
  that opened it counts as "outside"
- **Kobalte (`@kobalte/core`) only from a lazy route chunk** (`Workspace`,
  `Settings`). Its first component costs ~27 KB gzip; importing one from
  `AppLayout` or any eager module puts that in the startup bundle. corvu is the
  eager-side counterpart: `corvu/dialog` costs ~5 KB. An entrance animation on
  a Kobalte or corvu panel goes on `[data-expanded]` / the inner `.popover` —
  an ungated `animation` on the panel makes its presence logic wait forever to
  unmount
- Toasts go through `shell.showToast(text, undo?)`; destructive actions get a
  5s undo tombstone (see Workspace.remove) rather than a confirm dialog
- Comments in code explain _why_, in English (`just comments` rejects Japanese)
- **No user-visible string is written inline.** Add it to both tables in
  `lib/i18n.ts` and read it with `t()` — inside JSX or a memo, so switching
  the language redraws. Sentences with numbers are functions, not templates.
  Tests run in Japanese (`src/test-setup.ts`); say `setLocale("en")` to see
  the other side

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
