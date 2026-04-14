import { createSignal, createEffect, on } from "solid-js";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownPreviewProps {
  source: string;
}

export default function MarkdownPreview(props: MarkdownPreviewProps) {
  const [html, setHtml] = createSignal("");

  createEffect(
    on(
      () => props.source,
      async (source) => {
        if (!source) {
          setHtml("");
          return;
        }
        const rendered = await renderMarkdown(source);
        setHtml(rendered);
      },
    ),
  );

  return <div class="markdown-preview" innerHTML={html()} />;
}
