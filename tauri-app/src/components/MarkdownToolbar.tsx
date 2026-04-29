import { Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Editor } from "@milkdown/kit/core";
import { commandsCtx } from "@milkdown/kit/core";
import {
  sinkListItemCommand,
  liftListItemCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from "@milkdown/kit/preset/commonmark";
import Icon from "./Icon";

interface MarkdownToolbarProps {
  editor: Editor | undefined;
}

export default function MarkdownToolbar(props: MarkdownToolbarProps) {
  const exec = (run: (editor: Editor) => void) => {
    const editor = props.editor;
    if (!editor) return;
    run(editor);
    const pm = document.querySelector(".ProseMirror") as HTMLElement | null;
    pm?.focus();
  };

  return (
    <Show when={props.editor}>
      <Portal>
        <div class="markdown-toolbar" role="toolbar" aria-label="Markdown formatting">
          <button
            type="button"
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
            onClick={() =>
              exec((e) => e.action((ctx) => ctx.get(commandsCtx).call(insertHrCommand.key)))
            }
            aria-label="Horizontal rule"
            title="Horizontal rule"
          >
            <Icon name="minus" size={18} />
          </button>
        </div>
      </Portal>
    </Show>
  );
}
