import { onCleanup, onMount } from "solid-js";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
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
import { exitCodeBlockPlugin } from "../lib/exit-code-block-plugin";
import { mermaidPreviewPlugin } from "../lib/mermaid-preview-plugin";
import { createPlaceholderPlugin } from "../lib/placeholder-plugin";
import { getShikiTheme } from "../lib/theme";
import type { JSX } from "solid-js";

interface MilkdownEditorProps {
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  onEditorReady?: (editor?: Editor) => void;
}

export default function MilkdownEditor(props: MilkdownEditorProps): JSX.Element {
  let ref: HTMLDivElement | undefined;
  let editor: Editor | undefined;

  onMount(async () => {
    const root = ref;
    if (!root) {
      return;
    }

    const highlighter = await getHighlighter();

    // Shiki's Highlighter type is structurally compatible but comes from a
    // different copy of the package than the one @milkdown/plugin-highlight
    // resolves, so the nominal types do not line up.
    const parser = createParser(highlighter as Parameters<typeof createParser>[0], {
      theme: getShikiTheme(),
    });

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
      .use(mermaidPreviewPlugin)
      .use(props.placeholder ? createPlaceholderPlugin(props.placeholder) : [])
      .create();

    props.onEditorReady?.(editor);
  });

  onCleanup(() => {
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

export { type MilkdownEditorProps };
