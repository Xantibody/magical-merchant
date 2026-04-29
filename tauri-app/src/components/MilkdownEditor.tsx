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
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { exitCodeBlockPlugin } from "../lib/exit-code-block-plugin";
import { createPlaceholderPlugin } from "../lib/placeholder-plugin";
import { getShikiTheme } from "../lib/theme";

interface MilkdownEditorProps {
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  onEditorReady?: (editor: Editor | undefined) => void;
}

export default function MilkdownEditor(props: MilkdownEditorProps) {
  let ref: HTMLDivElement | undefined;
  let editor: Editor | undefined;

  onMount(async () => {
    if (!ref) return;

    const highlighter = await createHighlighterCore({
      themes: [
        import("shiki/themes/github-dark-default.mjs"),
        import("shiki/themes/github-light-default.mjs"),
      ],
      langs: [
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/bash.mjs"),
      ],
      engine: createJavaScriptRegexEngine(),
    });

    const parser = createParser(highlighter as any, {
      theme: getShikiTheme(),
    });

    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, ref!);
        if (props.defaultValue) {
          ctx.set(defaultValueCtx, props.defaultValue);
        }
        ctx.set(highlightPluginConfig.key, { parser });
        if (props.onChange) {
          const onChange = props.onChange;
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
      .use(props.placeholder ? createPlaceholderPlugin(props.placeholder) : [])
      .create();

    props.onEditorReady?.(editor);
  });

  onCleanup(() => {
    editor?.destroy();
    props.onEditorReady?.(undefined);
  });

  const handleClick = (e: MouseEvent) => {
    if (!ref) return;
    const prosemirror = ref.querySelector(".ProseMirror") as HTMLElement | null;
    if (prosemirror && e.target === ref) {
      prosemirror.focus();
    }
  };

  return <div ref={ref} class="milkdown-editor" onClick={handleClick} />;
}

export { type MilkdownEditorProps };
