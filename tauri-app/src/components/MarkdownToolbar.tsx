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

/** ボタン 1 つ。label は aria-label と title の両方に使う。 */
interface ToolbarButton {
  /** アイコンで見せるボタン。`glyph` とはどちらか片方だけを持つ */
  icon?: IconName;
  /** 記号そのものが意味を持つボタン(`[[`)は、アイコンにせず文字で見せる */
  glyph?: string;
  label: () => string;
  run: (editor: Editor) => void;
  /** 真のあいだだけ出すボタン。持たないものは常に出る */
  when?: () => boolean;
  /** 本文のフォーカスを放すのが目的のボタン。走らせたあと戻さない */
  releases?: true;
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

/** 本文の contenteditable。書式バーがフォーカスを預け入れ・引き取りする相手。 */
function bodyElement(editor: Editor): HTMLElement | null {
  return (
    editor.action((ctx) => {
      const root = ctx.get(rootCtx) as HTMLElement;
      return root.querySelector<HTMLElement>(".ProseMirror");
    }) ?? null
  );
}

/**
 * キーボードを畳む。閉じるよう頼む API は無く、本文のフォーカスを放すのが
 * 唯一の手立て。書き終わって下まで読みたいときの出口。
 */
function closeKeyboard(editor: Editor): void {
  bodyElement(editor)?.blur();
}

/**
 * スマホのキーボードの上に出る書式バー。Slack や Notion、Obsidian のモバイル
 * 版と同じ並びで、打ちにくい記法から順に: リストの種類(`- ` `1. ` `- [ ]`
 * は IME 経由だと入力ルールが効きにくい)、字下げ、ノートへのリンク、コード。
 *
 * 数は 7 個 + 閉じるに絞ってある。キーボードの上の一行は 44px の当たり判定を
 * 並べるだけで幅が尽きるので、他の入口があるもの(区切り線は `---` の入力
 * ルール、ブロック削除は選択して消す)はここに置かない。
 */
export default function MarkdownToolbar(props: MarkdownToolbarProps): JSX.Element {
  const toolbarTop = createKeyboardTop();
  // 「ブロックから抜ける」を出すかどうか。コードブロックの中でしか意味がない
  const [inCodeBlock, setInCodeBlock] = createSignal(false);

  // ツールバーが出ている間(=編集中)は下部タブを隠す。fixed のツールバーが
  // タブに重なって Scrawl / Notes が押せない・誤タップでモードが変わる、の
  // 両方をここで断つ
  onMount(() => {
    document.body.classList.add("md-toolbar-open");
    onCleanup(() => document.body.classList.remove("md-toolbar-open"));
  });

  // カーソルの居場所を追う。listener の購読は外せないが、エディタと一緒に
  // 捨てられる instance に付くので溜まらない。畳んだ後に書かないよう live で閉じる
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
    // スマホに Mod-Enter は無いので、コードブロックの中ではここが唯一の出口
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
                // 押し下げの既定動作は本文からフォーカスを奪う。IME の変換中に
                // それが起きると書きかけの文字が確定されずに落ちる (#102)
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
