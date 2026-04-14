import { onCleanup, onMount } from "solid-js";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { shikiPlugin } from "../lib/shiki-plugin";

interface MilkdownEditorProps {
  defaultValue?: string;
  onChange?: (markdown: string) => void;
  placeholder?: string;
}

export default function MilkdownEditor(props: MilkdownEditorProps) {
  let ref: HTMLDivElement | undefined;
  let editor: Editor | undefined;

  onMount(async () => {
    if (!ref) return;

    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, ref!);
        if (props.defaultValue) {
          ctx.set(defaultValueCtx, props.defaultValue);
        }
        if (props.onChange) {
          const onChange = props.onChange;
          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChange(markdown);
          });
        }
      })
      .use(commonmark)
      .use(listener)
      .use(shikiPlugin)
      .create();
  });

  onCleanup(() => {
    editor?.destroy();
  });

  return (
    <div
      ref={ref}
      class="milkdown-editor"
      data-placeholder={props.placeholder}
    />
  );
}

export { type MilkdownEditorProps };
