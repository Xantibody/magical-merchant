import { onCleanup, onMount } from "solid-js";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/kit/core";
import { Selection, TextSelection } from "@milkdown/kit/prose/state";
import { commonmark } from "@milkdown/kit/preset/commonmark";
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
import { createPlaceholderPlugin } from "../lib/placeholder-plugin";
import { createNoteLinkPlugin } from "../lib/note-link-plugin";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import { getShikiTheme } from "../lib/theme";
import type { JSX } from "solid-js";

/** プレビューで押された場所。エディタが立ち上がったらここへカーソルを置く。 */
interface CaretPoint {
  x: number;
  y: number;
  /** 押した瞬間のスクロール量。先に戻さないと同じ座標が別の行を指す。 */
  scrollTop: number;
}

interface MilkdownEditorProps {
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  onEditorReady?: (editor?: Editor) => void;
  caret?: CaretPoint;
  /** `[[` の補完候補とチップ表示に使うリンク先。渡したときだけ有効。 */
  noteLinks?: () => NoteLinkTarget[];
}

export default function MilkdownEditor(props: MilkdownEditorProps): JSX.Element {
  let ref: HTMLDivElement | undefined;
  let editor: Editor | undefined;
  /** アンマウント後にカーソル配置の遅延処理が走らないように。 */
  let disposed = false;
  let cancelCaret: (() => void) | undefined;

  /** プレビューと同じ景色に戻してから、押された座標の文字にカーソルを置く。 */
  const placeCaret = (created: Editor): void => {
    const { caret } = props;
    if (!caret) {
      return;
    }
    // 入力はすぐ受け付ける(モバイルはここでキーボードが開き始める)。
    // 編集モードでスクロールするのはプレビューの親ではなく .milkdown-editor
    created.action((ctx) => ctx.get(editorViewCtx).focus());
    const scroller = ref;

    // コードの装飾や図は create の後から伸びてくる。高さが足りないうちに
    // scrollTop を戻すとクランプされ、同じ座標が別の行を指してしまう。
    // 元のスクロール量まで戻せる高さに育ったら景色を戻し、カーソルを置く
    let done = false;
    const pending: { observer?: ResizeObserver; deadline?: ReturnType<typeof setTimeout> } = {};
    const cancel = (): void => {
      pending.observer?.disconnect();
      if (pending.deadline !== undefined) {
        clearTimeout(pending.deadline);
      }
    };
    const apply = (force: boolean): void => {
      if (done || disposed) {
        return;
      }
      const grown = !scroller || scroller.scrollHeight - scroller.clientHeight >= caret.scrollTop;
      if (!grown && !force) {
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
        // プレビューとエディタで行の高さは微妙に違う。外したら末尾に倒す
        const selection = found
          ? TextSelection.near(view.state.doc.resolve(found.pos))
          : Selection.atEnd(view.state.doc);
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
      });
    };
    pending.observer = new ResizeObserver(() => apply(false));
    created.action((ctx) => pending.observer?.observe(ctx.get(editorViewCtx).dom));
    // 図がプレビューより低く終わって高さが届かないこともある。1 秒で
    // 見切って、そのとき見えている中で一番近い場所に置く
    pending.deadline = setTimeout(() => apply(true), 1000);
    // onCleanup は await 後のここでは owner がいない。外の onCleanup から呼ぶ
    cancelCaret = cancel;
    apply(false);
  };

  onMount(async () => {
    const root = ref;
    if (!root) {
      return;
    }

    const highlighter = await getHighlighter();

    // Shiki's Highlighter type is structurally compatible but comes from a
    // different copy of the package than the one @milkdown/plugin-highlight
    // resolves, so the nominal types do not line up.
    // 言語入力の補完候補(コードブロック共有の datalist)
    ensureLanguageDatalist(document, buildLanguageSuggestions(highlighter.getLoadedLanguages()));

    // 未読込の言語(mermaid など)は素通しにして ShikiError を防ぐ(#101)
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
      .use(props.placeholder ? createPlaceholderPlugin(props.placeholder) : [])
      .use(props.noteLinks ? createNoteLinkPlugin(props.noteLinks) : [])
      .create();

    placeCaret(editor);
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

  return <div ref={ref} class="milkdown-editor" role="presentation" onClick={handleClick} />;
}

export { type CaretPoint, type MilkdownEditorProps };
