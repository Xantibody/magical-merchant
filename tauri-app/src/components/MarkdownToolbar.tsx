import { Show, createSignal, onMount, onCleanup } from "solid-js";
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
import Icon from "./Icon";
import type { JSX } from "solid-js";

interface MarkdownToolbarProps {
  editor: Editor | undefined;
}

/** これ以下の縮みはスクロールバーや URL バーの誤差で、キーボードとは見なさない。 */
const KEYBOARD_MIN_HEIGHT = 100;

/**
 * キーボードの上端。閉じているあいだは `undefined` を返し、CSS の
 * `bottom: var(--safe-bottom)` に任せる。
 *
 * Android では閉じていても `visualViewport.height` がナビゲーションバーを含んだ
 * 全高になるため、その値で `top` を固定するとツールバーがバーの裏に潜り込む。
 */
export function keyboardTop(
  viewport: { offsetTop: number; height: number },
  windowHeight: number,
): number | undefined {
  if (viewport.height >= windowHeight - KEYBOARD_MIN_HEIGHT) {
    return undefined;
  }
  return viewport.offsetTop + viewport.height;
}

export default function MarkdownToolbar(props: MarkdownToolbarProps): JSX.Element {
  const [toolbarTop, setToolbarTop] = createSignal<number | undefined>();

  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) {
      return;
    }

    const update = () => {
      setToolbarTop(keyboardTop(vv, window.innerHeight));
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    onCleanup(() => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    });
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

  const top = () => toolbarTop();

  return (
    <Show when={props.editor}>
      <Portal>
        <div
          class="markdown-toolbar"
          role="toolbar"
          aria-label="Markdown formatting"
          style={
            top() === undefined
              ? undefined
              : { top: `${top()}px`, bottom: "auto", transform: "translateY(-100%)" }
          }
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
            aria-label="ブロックから抜ける"
            title="ブロックから抜ける"
          >
            <Icon name="arrow-line-down" size={18} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => execCommand(deleteCurrentBlock)}
            aria-label="ブロックを削除"
            title="ブロックを削除"
          >
            <Icon name="trash" size={18} />
          </button>
        </div>
      </Portal>
    </Show>
  );
}
