import { createEffect, createSignal, Show, onCleanup, onMount } from "solid-js";
import TableMenu from "./TableMenu";
import { tableMenuPlugin } from "../lib/table-menu-plugin";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/kit/core";
import { Selection, TextSelection } from "@milkdown/kit/prose/state";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { cursor } from "@milkdown/kit/plugin/cursor";
import { history } from "@milkdown/kit/plugin/history";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { linkTooltipPlugin } from "@milkdown/kit/component/link-tooltip";
import { highlight, highlightPluginConfig } from "@milkdown/plugin-highlight";
import { createParser } from "@milkdown/plugin-highlight/shiki";
import { getHighlighter } from "../lib/highlighter";
import { withKnownLanguages } from "../lib/highlight-parser";
import { buildLanguageSuggestions, ensureLanguageDatalist } from "../lib/language-suggestions";
import { exitCodeBlockPlugin } from "../lib/exit-code-block-plugin";
import { codeBlockViewPlugin } from "../lib/code-block-view-plugin";
import { codeBlockActivePlugin } from "../lib/code-block-active-plugin";
import { taskItemPlugin } from "../lib/task-item-plugin";
import { listKeymapPlugin } from "../lib/list-keymap-plugin";
import { tabKeymapPlugin } from "../lib/tab-keymap-plugin";
import { hrSelectionPlugin } from "../lib/hr-selection-plugin";
import { DIAGRAM_SETTLED_EVENT, hasPendingDiagram } from "../lib/diagram-pending";
import { createPlaceholderPlugin } from "../lib/placeholder-plugin";
import { createNoteLinkPlugin } from "../lib/note-link-plugin";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import { createGlyphPlugin } from "../lib/glyph-plugin";
import { createExamplePlugin } from "../lib/example-plugin";
import { getShikiTheme } from "../lib/theme";
import "../styles/editor.css";
import type { JSX } from "solid-js";

/** The spot pressed in the preview. Once the editor is up, the caret goes here. */
interface CaretPoint {
  x: number;
  y: number;
  /** Scroll offset at the moment of the press. Unless restored first, the same point names another line */
  scrollTop: number;
}

interface MilkdownEditorProps {
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  onEditorReady?: (editor?: Editor) => void;
  caret?: CaretPoint;
  /** Link targets for the `[[` completion and the chips. Active only when given. */
  noteLinks?: () => NoteLinkTarget[];
  /** Registry that shows `:name:` as an image. Active only when given. */
  glyphs?: () => ReadonlyMap<string, string>;
  /** Heading to template examples. Never enters the document; shown as faint text only. */
  examples?: () => ReadonlyMap<string, string[]>;
}

/**
 * The element that actually scrolls. The editor only grows with its content;
 * scrolling belongs to the same parent as the preview (Workspace's .detail-body).
 * Looking at overflow instead of binding to a class name keeps this component
 * free of the structure it is placed in.
 */
function closestScroller(el: HTMLElement): HTMLElement | undefined {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") {
      return node;
    }
  }
  return undefined;
}

export default function MilkdownEditor(props: MilkdownEditorProps): JSX.Element {
  let ref: HTMLDivElement | undefined;
  let editor: Editor | undefined;
  const [ready, setReady] = createSignal<Editor>();
  /** Keeps the deferred caret placement from running after unmount. */
  let disposed = false;
  let cancelCaret: (() => void) | undefined;

  /** Restore the view the preview had, then put the caret on the character at the pressed point. */
  const placeCaret = (created: Editor): void => {
    const { caret } = props;
    if (!caret) {
      return;
    }
    // Accept input right away (on mobile the keyboard starts opening here)
    created.action((ctx) => ctx.get(editorViewCtx).focus());
    // scrollTop was measured on the same scroll element the moment the preview was pressed
    const root = ref;
    const scroller = root ? closestScroller(root) : undefined;

    // Code decorations and diagrams grow in after create. Restoring scrollTop
    // while the height is still short gets it clamped, and the same point names
    // another line. Once the content is tall enough to reach the original scroll
    // offset, restore the view and place the caret
    let done = false;
    const pending: {
      observer?: ResizeObserver;
      deadline?: ReturnType<typeof setTimeout>;
      settled?: () => void;
    } = {};
    const cancel = (): void => {
      pending.observer?.disconnect();
      if (pending.settled) {
        root?.removeEventListener(DIAGRAM_SETTLED_EVENT, pending.settled);
      }
      if (pending.deadline !== undefined) {
        clearTimeout(pending.deadline);
      }
    };
    const apply = (force: boolean): void => {
      if (done || disposed) {
        return;
      }
      const grown = !scroller || scroller.scrollHeight - scroller.clientHeight >= caret.scrollTop;
      // At create time a diagram still occupies the height of its source. Resolving
      // the point before it finishes drawing makes everything below the diagram
      // name a different block (#168). With scrollTop 0 grown is always true, so
      // this wait is needed separately
      const drawn = !root || !hasPendingDiagram(root);
      if ((!grown || !drawn) && !force) {
        return;
      }
      done = true;
      cancel();
      if (scroller) {
        scroller.scrollTop = caret.scrollTop;
      }
      created.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const found = view.posAtCoords({ left: caret.x, top: caret.y });
        // The geometry matches the preview (styles/workspace.test.ts), but a diagram
        // redraw or the like can still put it off. Then fall back to the end
        const selection = found
          ? TextSelection.near(view.state.doc.resolve(found.pos))
          : Selection.atEnd(view.state.doc);
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
      });
    };
    pending.observer = new ResizeObserver(() => apply(false));
    created.action((ctx) => pending.observer?.observe(ctx.get(editorViewCtx).dom));
    // A diagram finishing may not change the height (the body is already long
    // enough, or the diagram is as tall as its source). Listen for the signal
    // instead of relying on ResizeObserver alone
    pending.settled = (): void => apply(false);
    root?.addEventListener(DIAGRAM_SETTLED_EVENT, pending.settled);
    // A diagram may end up shorter than in the preview and the height never
    // arrives. A diagram that never finishes drawing is cut off here too. After
    // 1 second, place the caret at the nearest spot visible at that moment
    pending.deadline = setTimeout(() => apply(true), 1000);
    // onCleanup has no owner here, after the await. The outer onCleanup calls this
    cancelCaret = cancel;
    apply(false);
  };

  // Showing or hiding the examples does not touch the document, so ProseMirror
  // has no reason to redraw. Dispatch one empty transaction to make it recompute
  // the decorations: neither document nor caret changes, only the faint text
  // appears or disappears
  createEffect(() => {
    props.examples?.();
    editor?.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr);
    });
  });

  onMount(async () => {
    const root = ref;
    if (!root) {
      return;
    }

    const highlighter = await getHighlighter();

    // Shiki's Highlighter type is structurally compatible but comes from a
    // different copy of the package than the one @milkdown/plugin-highlight
    // resolves, so the nominal types do not line up.
    // Completion candidates for the language input (a datalist shared by code blocks)
    ensureLanguageDatalist(document, buildLanguageSuggestions(highlighter.getLoadedLanguages()));

    // Pass unloaded languages (mermaid and so on) through untouched to avoid a ShikiError (#101)
    const parser = withKnownLanguages(
      createParser(highlighter as Parameters<typeof createParser>[0], {
        theme: getShikiTheme(),
      }),
      highlighter.getLoadedLanguages(),
    );

    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        if (props.defaultValue) {
          ctx.set(defaultValueCtx, props.defaultValue);
        }
        ctx.set(highlightPluginConfig.key, { parser });
        if (props.onChange) {
          const { onChange } = props;
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChange(markdown);
          });
        }
      })
      .use(commonmark)
      // The preview (markdown-it) draws tables and strikethrough by default. Now
      // that the editor is always open, without them here a note collapses into
      // paragraphs of pipes the moment it opens. Column resizing
      // (columnResizingPlugin) is not part of gfm and not in Markdown, so it stays out
      .use(gfm)
      .use(tableMenuPlugin)
      .use(listener)
      .use(highlight)
      .use(cursor)
      .use(history)
      .use(clipboard)
      .use(trailing)
      .use(linkTooltipPlugin)
      .use(exitCodeBlockPlugin)
      .use(codeBlockViewPlugin)
      .use(codeBlockActivePlugin)
      .use(taskItemPlugin)
      .use(listKeymapPlugin)
      .use(tabKeymapPlugin)
      .use(hrSelectionPlugin)
      .use(props.placeholder ? createPlaceholderPlugin(props.placeholder) : [])
      .use(props.noteLinks ? createNoteLinkPlugin(props.noteLinks) : [])
      .use(props.glyphs ? createGlyphPlugin(props.glyphs) : [])
      .use(props.examples ? createExamplePlugin(props.examples) : [])
      .create();

    // Torn down while create was pending (the list was stepped through quickly, or
    // the body was swapped). onCleanup already ran without knowing the editor, so
    // it is discarded here. The host uses onEditorReady as the signal that
    // ProseMirror exists; handing it one built on a root that is gone would send a
    // caret placement into nothing
    if (disposed) {
      editor.destroy();
      editor = undefined;
      return;
    }

    placeCaret(editor);
    setReady(editor);
    props.onEditorReady?.(editor);
  });

  onCleanup(() => {
    disposed = true;
    cancelCaret?.();
    editor?.destroy();
    props.onEditorReady?.();
  });

  const handleClick = (e: MouseEvent) => {
    if (!ref) {
      return;
    }
    const prosemirror = ref.querySelector(".ProseMirror") as HTMLElement | null;
    if (prosemirror && e.target === ref) {
      prosemirror.focus();
    }
  };

  return (
    <div class="milkdown-editor" role="presentation" onClick={handleClick}>
      <div class="editor-table-slot">
        <Show when={ready()}>{(created) => <TableMenu editor={created()} />}</Show>
      </div>
      <div ref={ref} class="editor-content" />
    </div>
  );
}

export { type CaretPoint, type MilkdownEditorProps };
