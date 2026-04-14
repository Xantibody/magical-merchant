import { onCleanup, onMount } from "solid-js";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";

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
      .create();
  });

  onCleanup(() => {
    editor?.destroy();
  });

  const getMarkdown = (): string => {
    if (!editor) return "";
    return editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serializer = ctx.get(serializerCtx);
      return serializer(view.state.doc);
    });
  };

  return (
    <div
      ref={ref}
      class="milkdown-editor"
      data-placeholder={props.placeholder}
    />
  );
}

export { type MilkdownEditorProps };
