# Magical Merchant

A minimal note-taking desktop app with Rust core logic and a lightweight UI.

## Design Priorities (in order)

1. **Simple UI** — Minimal chrome, full-screen memo area, hidden actions
2. **Lightweight** — Small bundle, fast startup, no unnecessary dependencies
3. **Stylish** — Clean aesthetics with design tokens (Open Props) and Phosphor Icons

When making UI decisions, always evaluate against these priorities in order.
If a feature adds visual complexity, it must justify itself against simplicity.
If a dependency adds weight, it must justify itself against lightness.

## Tech Stack

| Layer            | Technology                                  |
| ---------------- | ------------------------------------------- |
| Core logic       | Rust (`core/` crate, framework-independent) |
| Desktop app      | Tauri 2 + SolidJS                           |
| Styling          | Open Props (CSS custom properties)          |
| Icons            | Phosphor Icons (SVG files)                  |
| Editor           | Milkdown (headless, SolidJS integration)    |
| Syntax highlight | Shiki                                       |
| Markdown         | markdown-it + Shiki                         |

## Milkdown Plugins

| Category | Plugin                    | Import                                 | Purpose                       |
| -------- | ------------------------- | -------------------------------------- | ----------------------------- |
| Built-in | `commonmark`              | `@milkdown/kit/preset/commonmark`      | Base Markdown                 |
| Built-in | `listener`                | `@milkdown/kit/plugin/listener`        | onChange callback             |
| Built-in | `cursor`                  | `@milkdown/kit/plugin/cursor`          | Gap cursor + drop cursor      |
| Built-in | `history`                 | `@milkdown/kit/plugin/history`         | Undo/Redo                     |
| Built-in | `clipboard`               | `@milkdown/kit/plugin/clipboard`       | Improved copy/paste           |
| Built-in | `trailing`                | `@milkdown/kit/plugin/trailing`        | Trailing paragraph            |
| Built-in | `linkTooltipPlugin`       | `@milkdown/kit/component/link-tooltip` | Link preview/edit             |
| External | `highlight`               | `@milkdown/plugin-highlight`           | Shiki syntax highlighting     |
| Custom   | `exitCodeBlockPlugin`     | `src/lib/exit-code-block-plugin.ts`    | Mod-Enter to exit code blocks |
| Custom   | `createPlaceholderPlugin` | `src/lib/placeholder-plugin.ts`        | Empty document placeholder    |

Rejected plugins (with reasons):

- `block` / `tooltip` / `slash` — add visible chrome, conflicts with "simple UI"
- `code-block` component — requires CodeMirror (~150KB), conflicts with "lightweight"
- `indent` / `upload` / `image-*` / `table-block` / `list-item-block` — no current feature need

## Editor Performance Principles

Three non-negotiable constraints for Markdown editor design:

1. **Keep the DOM small** — Virtualize or skip nodes outside the visible viewport. DOM node count must not grow linearly with document size
2. **Localize conversion** — Never re-convert the entire Markdown to HTML and replace via innerHTML. Convert only the changed line/block and leverage Solid's fine-grained reactivity
3. **Preserve scroll and selection** — Cursor position, text selection, and scroll offset must survive DOM updates. Full innerHTML replacement destroys these and is prohibited

Reject any implementation that violates these principles, regardless of feature completeness.

## UI Architecture

- **Header**: Toggle button (menu open/close) + current mode icon only
- **Toggle menu**: 3 modes — Timeline / Notes / Tasks
- **Memo area**: Occupies the full screen
- **Actions**: Hidden by default, shown on hover (PC) / flick (mobile)
- **Editing**: Inline Markdown live conversion (Typora-style)
