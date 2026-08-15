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

| Category | Plugin                                                                        | Purpose                                |
| -------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| Built-in | commonmark, listener, cursor, history, clipboard, trailing, linkTooltipPlugin | base editing                           |
| External | @milkdown/plugin-highlight                                                    | Shiki syntax highlighting              |
| Custom   | exit-code-block-plugin                                                        | Mod-Enter exits code blocks            |
| Custom   | placeholder-plugin                                                            | empty-document placeholder             |
| Custom   | code-block-view-plugin                                                        | language input + copy + mermaid figure |
| Custom   | code-block-active-plugin                                                      | is-active class on touched code blocks |

**Rejected** (do not re-propose): block/tooltip/slash (visible chrome),
code-block component (CodeMirror ~150KB), indent/upload/image-\*/table-block/
list-item-block (no need).

## Rules

- **Frontmatter never enters the editor.** Milkdown serializes it back as
  escaped text and corrupts the file. Read/write body only (`note-view.ts`)
- **IME**: Enter during composition belongs to the IME — guard every
  Enter-to-commit with `isImeComposing(e)` (see #102, CommandPalette)
- Autosave: 1s debounce + serialized save chain (`update_draft`); don't refetch
  the note list on every save — once, when editing ends
- Touch devices get `MarkdownToolbar` (lazy, only while an editor exists) for
  hard-to-type syntax
- Stale async reads: after any await, re-check the selection still points at
  the note you loaded before writing state (see Workspace body loader)
