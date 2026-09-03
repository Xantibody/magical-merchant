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
import { DIAGRAM_SETTLED_EVENT, hasPendingDiagram } from "../lib/diagram-pending";
import { createPlaceholderPlugin } from "../lib/placeholder-plugin";
import { createNoteLinkPlugin } from "../lib/note-link-plugin";
import type { NoteLinkTarget } from "../lib/note-link-plugin";
import { createGlyphPlugin } from "../lib/glyph-plugin";
import { getShikiTheme } from "../lib/theme";
import "../styles/editor.css";
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
  /** `:name:` を画像で見せるための登録表。渡したときだけ有効。 */
  glyphs?: () => ReadonlyMap<string, string>;
}

/**
 * 実際にスクロールしている要素。エディタは中身に合わせて伸びるだけで、
 * スクロールはプレビューと同じ親(Workspace の .detail-body)が担う。
 * クラス名で結ばずに overflow を見るのは、この部品を置く側の構造に
 * 依存させないため。
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
  /** アンマウント後にカーソル配置の遅延処理が走らないように。 */
  let disposed = false;
  let cancelCaret: (() => void) | undefined;

  /** プレビューと同じ景色に戻してから、押された座標の文字にカーソルを置く。 */
  const placeCaret = (created: Editor): void => {
    const { caret } = props;
    if (!caret) {
      return;
    }
    // 入力はすぐ受け付ける(モバイルはここでキーボードが開き始める)
    created.action((ctx) => ctx.get(editorViewCtx).focus());
    // scrollTop はプレビューを押した瞬間に同じスクロール要素で測ったもの
    const root = ref;
    const scroller = root ? closestScroller(root) : undefined;

    // コードの装飾や図は create の後から伸びてくる。高さが足りないうちに
    // scrollTop を戻すとクランプされ、同じ座標が別の行を指してしまう。
    // 元のスクロール量まで戻せる高さに育ったら景色を戻し、カーソルを置く
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
      // 図は create の時点ではまだソースの高さで場所を取っている。描き終わる
      // 前に座標を引くと、図より下は丸ごと別のブロックを指す (#168)。
      // scrollTop 0 では grown が常に真なので、この待ちは別に要る
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
        // 幾何はプレビューと揃えてある(workspace.test.ts)が、図の描き直しなどで
        // 外れることはある。そのときは末尾に倒す
        const selection = found
          ? TextSelection.near(view.state.doc.resolve(found.pos))
          : Selection.atEnd(view.state.doc);
        view.dispatch(view.state.tr.setSelection(selection));
        view.focus();
      });
    };
    pending.observer = new ResizeObserver(() => apply(false));
    created.action((ctx) => pending.observer?.observe(ctx.get(editorViewCtx).dom));
    // 図の描き終わりは高さを変えないこともある(本文がもう十分に長い、図と
    // ソースの背丈が同じ)。ResizeObserver だけに頼らず合図も聞く
    pending.settled = (): void => apply(false);
    root?.addEventListener(DIAGRAM_SETTLED_EVENT, pending.settled);
    // 図がプレビューより低く終わって高さが届かないこともある。図が最後まで
    // 描けないときもここで見切る。1 秒で、そのとき見えている中で一番近い場所に置く
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
      .use(props.glyphs ? createGlyphPlugin(props.glyphs) : [])
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
