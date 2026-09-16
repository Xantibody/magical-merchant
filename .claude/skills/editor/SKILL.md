---
name: editor
description: Milkdown editor architecture, plugin policy, IME handling, and performance constraints. Use when touching the editor, Markdown rendering, or anything the cursor lives in.
---

# Editor (Milkdown)

## Performance principles — non-negotiable

1. **Keep the DOM small** — never let node count grow linearly with document size
2. **Localize conversion** — convert only the changed line/block; never
   re-convert the whole document and swap innerHTML
3. **Preserve scroll & selection** — cursor, selection, and scroll offset must
   survive every DOM update

Reject any implementation violating these, regardless of feature completeness.

## Loading discipline

Milkdown + ProseMirror load **lazily** on first edit (`lazy(() => import(...))`
in Workspace). markmap (d3) and Mermaid load on first use. Never import these
at module top-level from anything on the startup path.

## Plugin table

| Category | Plugin                                                                             | Purpose                                                                            |
| -------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Built-in | commonmark, gfm, listener, cursor, history, clipboard, trailing, linkTooltipPlugin | base editing; gfm = tables, strikethrough (what the preview draws)                 |
| External | @milkdown/plugin-highlight                                                         | Shiki syntax highlighting                                                          |
| Custom   | exit-code-block-plugin                                                             | Mod-Enter exits code blocks                                                        |
| Custom   | placeholder-plugin                                                                 | empty-document placeholder                                                         |
| Custom   | code-block-view-plugin                                                             | language input + copy + mermaid figure                                             |
| Custom   | code-block-active-plugin                                                           | is-active class on touched code blocks                                             |
| Custom   | task-item-plugin                                                                   | click on the box toggles a task item (gfm keeps only the attr)                     |
| Custom   | list-keymap-plugin                                                                 | Enter after a checked task starts unchecked; Backspace at an item's start lifts it |
| Custom   | tab-keymap-plugin                                                                  | Tab / Shift-Tab never leave the editor; in code blocks they indent                 |
| Custom   | hr-selection-plugin                                                                | after the `---` rule the cursor lands below the rule, not on it                    |

**Rejected** (do not re-propose): block/tooltip/slash (visible chrome),
code-block component (CodeMirror ~150KB), indent/upload/image-\*/table-block
(component — not the `gfm` preset)/list-item-block (no need), gfm's
`columnResizingPlugin` (column widths are not Markdown).

## Rules

- **Frontmatter never enters the editor.** Milkdown serializes it back as
  escaped text and corrupts the file. Read/write body only (`note-view.ts`)
- **IME**: Enter during composition belongs to the IME — guard every
  Enter-to-commit with `isImeComposing(e)` (see #102, CommandPalette)
- Autosave: 1s debounce + serialized save chain (`update_draft`); don't refetch
  the note list on every save — once, when editing ends
- Touch devices get `MarkdownToolbar` (lazy, only while an editor exists) for
  hard-to-type syntax. List buttons are toggles (`lib/list-commands.ts`): the
  `- ` / `1. ` input rules do not fire reliably through a mobile IME
- Key handling order: every `$prose` plugin runs before Milkdown's own keymap,
  so a `$prose` keymap pre-empts a preset key; a `$shortcut` with `priority: 0`
  runs after every preset key and is the place for fallbacks
- Stale async reads: after any await, re-check the selection still points at
  the note you loaded before writing state (see Workspace body loader)
