---
name: ui-design
description: UI component patterns, design tokens, layout and mobile conventions for the Tauri app. Use when creating or modifying any UI component, CSS, or view.
---

# UI & Design System

## Tokens — never hardcode

All colors go through the `--app-*` tokens in `styles/base.css` (built on
Open Props, with a dark theme via `:root[data-theme="dark"]`):

- Surfaces: `--app-surface`, `--app-surface-2`, `--app-sidebar`, `--app-input-bg`
- Text: `--app-text`, `--app-text-muted` (prose that accompanies, dates),
  `--app-text-faint` (labels, icons). Two helper steps, no third
- Lines: `--app-border` (controls), `--app-hairline` (rails, day separators),
  `--app-text-hint` (marks only; never words, despite the name)
- Accent: `--app-accent`, `--app-accent-soft` (chips, selected rows),
  `--app-on-accent` (words and icons on a filled accent), `--app-focus` (the
  keyboard focus ring, below)
- Elevation: `--shadow-pop` is the only shadow, and a box wearing it has no border.
  A toast has no shadow; a focus ring is not elevation
- Status: `--app-ok`, `--app-danger` (words and marks; a button fills with
  `--app-danger-fill` and writes `--app-on-danger`), `--app-undo`, toast pair

Helper text is 13px, a stamp, count or key 12px, and nothing is smaller
(`styles/polish.test.ts`).

The keyboard focus is one ring: `:focus-visible` in base.css draws 2px of
`--app-focus` 2px outside the control. A text field, and a row that sits flush
in a list, take it inside (`outline-offset: -2px`); a surface adds nothing but
that offset (`styles/focus.test.ts`).

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
4. A wide window is a 64px rail of places, then (Note / Codex) the list, then
   the page. The rail never folds; the list tucks under the page with its grip
   or `⌘\`. The note panel (`⌘.`) and the search field (`⌘K`) open from a key
   or a visible control. State is the status line at the top of the rail
5. One way to each thing. A place is changed in one spot, a record is made
   from the ring, search has one field per screen: before adding a control,
   find the one that already does the job
6. A control keeps its place from one screen to the next. The place pill, the
   round button at the lower right and the status dot stand at the same spot
   on every phone screen (`styles/layout.test.ts`); what a screen adds goes in
   the room between them
7. Bottom docks (`capture-dock`, now only Scrawl's select-mode bar) float; the
   scroll area pads its bottom so content never hides under them

## Mobile (max-width: 767px)

- No header: the page runs to the top edge, and everything pressed is at the
  foot — the place pill at the lower left, the page's one round button at the
  lower right, the status dot alone in the top right corner
- One pane at a time; a level's way back is the round button after the pill
  (a stroke to the right and Android's back do the same); hit targets ≥ 44px
- A popover opens beside the control that opened it (`lib/popover-place.ts`),
  not at a fixed place: the controls are at the foot, so it opens upward
- A control drawn smaller than that keeps its look and takes the rest as a box
  that paints nothing: add it to the list in `layout.css`, and keep its
  neighbours far enough apart that the boxes meet (`styles/hit-area.test.ts`)
- Safe areas come from `--safe-top` / `--safe-bottom` (set once in base.css —
  never use `env()` directly, tests can't fix it)
- Keyboard: expect the visual viewport to shrink; bottom docks must stay
  visible above the keyboard

## Priority checklist before merging

1. **Simple** — can it be simpler? does it add visible chrome?
2. **Lightweight** — deps, DOM nodes, lazy-load anything heavy
3. **Stylish** — tokens everywhere, intentional spacing
