import { Show, createEffect, createSignal, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { Editor } from "@milkdown/kit/core";
import { commandsCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  sinkListItemCommand,
  liftListItemCommand,
  createCodeBlockCommand,
} from "@milkdown/kit/preset/commonmark";
import type { Command } from "@milkdown/kit/prose/state";
import { exitCodeBlock, isInCodeBlock } from "../lib/block-commands";
import { toggleBulletList, toggleOrderedList, toggleTaskItem } from "../lib/list-commands";
import { startNoteLink } from "../lib/note-link-plugin";
import { t } from "../lib/i18n";
import { createKeyboardTop, keyboardTopStyle } from "../lib/keyboard";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import "../styles/markdown-toolbar.css";
import type { JSX } from "solid-js";

interface MarkdownToolbarProps {
  editor: Editor | undefined;
}

/** One button. label is used for both aria-label and title. */
interface ToolbarButton {
  /** A button shown as an icon. Has either this or `glyph`, never both */
  icon?: IconName;
  /** A button whose symbol carries the meaning (`[[`) is shown as text, not an icon */
  glyph?: string;
  label: () => string;
  run: (editor: Editor) => void;
  /** A button shown only while this is true. Buttons without it always show */
  when?: () => boolean;
  /** A button whose purpose is to let go of the body's focus. Not restored after it runs */
  releases?: true;
}

/** Fire a command registered with Milkdown. */
const milkdown =
  (key: typeof sinkListItemCommand.key) =>
  (editor: Editor): void => {
    editor.action((ctx) => ctx.get(commandsCtx).call(key));
  };

/** Fire a plain ProseMirror command that bypasses Milkdown's command registry. */
const prose =
  (command: Command) =>
  (editor: Editor): void =>
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      command(view.state, view.dispatch);
    });

/** The body's contenteditable. The element the toolbar hands focus to and takes it back from. */
function bodyElement(editor: Editor): HTMLElement | null {
  return (
    editor.action((ctx) => {
      const root = ctx.get(rootCtx) as HTMLElement;
      return root.querySelector<HTMLElement>(".ProseMirror");
    }) ?? null
  );
}

/**
 * Fold the keyboard. There is no API to ask it to close; letting go of the
 * body's focus is the only way. The exit for reading down to the end after writing.
 */
function closeKeyboard(editor: Editor): void {
  bodyElement(editor)?.blur();
}

/**
 * The formatting bar above the phone keyboard. Same order as the mobile versions
 * of Slack, Notion and Obsidian, hardest syntax to type first: list kinds (`- `,
 * `1. ` and `- [ ]` input rules rarely fire through an IME), indentation, a link
 * to a note, code.
 *
 * Kept to 7 buttons plus close (the exit-block button shows only inside a code
 * block). One row above the keyboard runs out of width just lining up 44px hit
 * targets, so anything with another way in (a rule via the `---` input rule,
 * block deletion via select and delete) is not placed here.
 */
export default function MarkdownToolbar(props: MarkdownToolbarProps): JSX.Element {
  const toolbarTop = createKeyboardTop();
  // Whether to show "exit block". It only means something inside a code block
  const [inCodeBlock, setInCodeBlock] = createSignal(false);

  // Hide the bottom tabs while the toolbar is up (that is, while editing). The
  // fixed toolbar overlapping the tabs makes Scrawl / Note unpressable and lets a
  // stray tap switch modes; both are cut off here
  onMount(() => {
    document.body.classList.add("md-toolbar-open");
    onCleanup(() => document.body.classList.remove("md-toolbar-open"));
  });

  // Track where the caret is. A listener subscription cannot be removed, but it
  // attaches to an instance discarded with the editor, so it does not pile up.
  // live shuts it so nothing is written after teardown
  createEffect(() => {
    const { editor } = props;
    if (!editor) {
      setInCodeBlock(false);
      return;
    }
    let live = true;
    onCleanup(() => {
      live = false;
    });
    editor.action((ctx) => {
      setInCodeBlock(isInCodeBlock(ctx.get(editorViewCtx).state.selection));
      ctx.get(listenerCtx).selectionUpdated((_ctx, selection) => {
        if (live) {
          setInCodeBlock(isInCodeBlock(selection));
        }
      });
    });
  });

  const exec = (button: ToolbarButton) => {
    const { editor } = props;
    if (!editor) {
      return;
    }
    button.run(editor);
    // Re-check right away whether the press moved the caret's location. Making
    // or unmaking a code block changes only the node type and leaves the
    // selection alone, so `selectionUpdated` never fires; waiting on it, "exit"
    // would not appear or disappear until the caret moves
    editor.action((ctx) => {
      setInCodeBlock(isInCodeBlock(ctx.get(editorViewCtx).state.selection));
    });
    if (!button.releases) {
      bodyElement(editor)?.focus();
    }
  };

  const buttons: ToolbarButton[] = [
    { icon: "list-bullets", label: () => t().editor.bulletList, run: prose(toggleBulletList) },
    { icon: "list-numbers", label: () => t().editor.orderedList, run: prose(toggleOrderedList) },
    { icon: "list-checks", label: () => t().editor.taskList, run: prose(toggleTaskItem) },
    {
      icon: "text-outdent",
      label: () => t().editor.outdent,
      run: milkdown(liftListItemCommand.key),
    },
    { icon: "text-indent", label: () => t().editor.indent, run: milkdown(sinkListItemCommand.key) },
    { glyph: "[[", label: () => t().editor.noteLink, run: prose(startNoteLink) },
    {
      icon: "code-block",
      label: () => t().editor.codeBlock,
      run: milkdown(createCodeBlockCommand.key),
    },
    // A phone has no Mod-Enter, so inside a code block this is the only way out
    {
      icon: "arrow-line-down",
      label: () => t().editor.exitBlock,
      run: prose(exitCodeBlock),
      when: inCodeBlock,
    },
    {
      icon: "caret-down",
      label: () => t().editor.closeKeyboard,
      run: closeKeyboard,
      releases: true,
    },
  ];

  return (
    <Show when={props.editor}>
      <Portal>
        <div
          class="markdown-toolbar"
          role="toolbar"
          aria-label="Markdown formatting"
          style={keyboardTopStyle(toolbarTop())}
        >
          {buttons.map((button) => (
            <Show when={button.when?.() ?? true}>
              <button
                type="button"
                class={button.releases ? "markdown-toolbar-release" : undefined}
                // The default pointerdown action takes focus off the body. During an
                // IME conversion that drops the half-typed characters unconfirmed (#102)
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => exec(button)}
                aria-label={button.label()}
                title={button.label()}
              >
                <Show
                  when={button.icon}
                  fallback={<span class="markdown-toolbar-glyph">{button.glyph}</span>}
                >
                  {(icon) => <Icon name={icon()} size={20} />}
                </Show>
              </button>
            </Show>
          ))}
        </div>
      </Portal>
    </Show>
  );
}
