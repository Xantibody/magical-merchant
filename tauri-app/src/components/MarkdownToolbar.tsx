import { Show, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { Editor } from "@milkdown/kit/core";
import { commandsCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import {
  sinkListItemCommand,
  liftListItemCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/kit/preset/commonmark";
import type { Command } from "@milkdown/kit/prose/state";
import { deleteCurrentBlock, exitCodeBlock } from "../lib/block-commands";
import { t } from "../lib/i18n";
import { createKeyboardTop, keyboardTopStyle } from "../lib/keyboard";
import Icon from "./Icon";
import "../styles/markdown-toolbar.css";
import type { JSX } from "solid-js";

interface MarkdownToolbarProps {
  editor: Editor | undefined;
}

export default function MarkdownToolbar(props: MarkdownToolbarProps): JSX.Element {
  const toolbarTop = createKeyboardTop();

  // ツールバーが出ている間(=編集中)は下部タブを隠す。fixed のツールバーが
  // タブに重なって Timeline / Notes が押せない・誤タップでモードが変わる、の
  // 両方をここで断つ
  onMount(() => {
    document.body.classList.add("md-toolbar-open");
    onCleanup(() => document.body.classList.remove("md-toolbar-open"));
  });

  const exec = (run: (editor: Editor) => void) => {
    const { editor } = props;
    if (!editor) {
      return;
    }
    run(editor);
    editor.action((ctx) => {
      const root = ctx.get(rootCtx) as HTMLElement;
      const pm = root.querySelector(".ProseMirror") as HTMLElement | null;
      pm?.focus();
    });
  };

  /** Milkdown のコマンド登録を介さない、素の ProseMirror コマンドを撃つ。 */
  const execCommand = (command: Command) => {
    exec((e) =>
      e.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        command(view.state, view.dispatch);
      }),
    );
  };

  return (
    <Show when={props.editor}>
      <Portal>
        <div
          class="markdown-toolbar"
          role="toolbar"
          aria-label="Markdown formatting"
          style={keyboardTopStyle(toolbarTop())}
        >
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() =>
              exec((e) => e.action((ctx) => ctx.get(commandsCtx).call(liftListItemCommand.key)))
            }
            aria-label="Outdent"
            title="Outdent"
          >
            <Icon name="text-outdent" size={18} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() =>
              exec((e) => e.action((ctx) => ctx.get(commandsCtx).call(sinkListItemCommand.key)))
            }
            aria-label="Indent"
            title="Indent"
          >
            <Icon name="text-indent" size={18} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() =>
              exec((e) => e.action((ctx) => ctx.get(commandsCtx).call(createCodeBlockCommand.key)))
            }
            aria-label="Code block"
            title="Code block"
          >
            <Icon name="code-block" size={18} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() =>
              exec((e) => e.action((ctx) => ctx.get(commandsCtx).call(insertHrCommand.key)))
            }
            aria-label="Horizontal rule"
            title="Horizontal rule"
          >
            <Icon name="minus" size={18} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => execCommand(exitCodeBlock)}
            aria-label={t().editor.exitBlock}
            title={t().editor.exitBlock}
          >
            <Icon name="arrow-line-down" size={18} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => execCommand(deleteCurrentBlock)}
            aria-label={t().editor.deleteBlock}
            title={t().editor.deleteBlock}
          >
            <Icon name="trash" size={18} />
          </button>
        </div>
      </Portal>
    </Show>
  );
}
