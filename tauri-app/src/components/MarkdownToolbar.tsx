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
import { toggleBulletList, toggleOrderedList, toggleTaskItem } from "../lib/list-commands";
import { t } from "../lib/i18n";
import { createKeyboardTop, keyboardTopStyle } from "../lib/keyboard";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import "../styles/markdown-toolbar.css";
import type { JSX } from "solid-js";

interface MarkdownToolbarProps {
  editor: Editor | undefined;
}

/** ボタン 1 つ。label は aria-label と title の両方に使う。 */
interface ToolbarButton {
  icon: IconName;
  label: () => string;
  run: (editor: Editor) => void;
}

/** Milkdown に登録されたコマンドを撃つ。 */
const milkdown =
  (key: typeof sinkListItemCommand.key) =>
  (editor: Editor): void => {
    editor.action((ctx) => ctx.get(commandsCtx).call(key));
  };

/** Milkdown のコマンド登録を介さない、素の ProseMirror コマンドを撃つ。 */
const prose =
  (command: Command) =>
  (editor: Editor): void =>
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      command(view.state, view.dispatch);
    });

/**
 * スマホのキーボードの上に出る書式バー。Slack や Notion、Obsidian のモバイル
 * 版と同じ並びで、打ちにくい記法から順に: リストの種類(`- ` `1. ` `- [ ]`
 * は IME 経由だと入力ルールが効きにくい)、字下げ、ブロックの挿入と脱出。
 */
export default function MarkdownToolbar(props: MarkdownToolbarProps): JSX.Element {
  const toolbarTop = createKeyboardTop();

  // ツールバーが出ている間(=編集中)は下部タブを隠す。fixed のツールバーが
  // タブに重なって Scrawl / Notes が押せない・誤タップでモードが変わる、の
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
    {
      icon: "code-block",
      label: () => t().editor.codeBlock,
      run: milkdown(createCodeBlockCommand.key),
    },
    { icon: "minus", label: () => t().editor.horizontalRule, run: milkdown(insertHrCommand.key) },
    { icon: "arrow-line-down", label: () => t().editor.exitBlock, run: prose(exitCodeBlock) },
    { icon: "trash", label: () => t().editor.deleteBlock, run: prose(deleteCurrentBlock) },
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
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => exec(button.run)}
              aria-label={button.label()}
              title={button.label()}
            >
              <Icon name={button.icon} size={18} />
            </button>
          ))}
        </div>
      </Portal>
    </Show>
  );
}
