import { createSignal, createEffect, on } from "solid-js";
import { renderMarkdown } from "../lib/markdown";

interface MarkdownPreviewProps {
  source: string;
}

export default function MarkdownPreview(props: MarkdownPreviewProps) {
  const [html, setHtml] = createSignal("");

  let renderVersion = 0;

  createEffect(
    on(
      () => props.source,
      async (source) => {
        const currentVersion = ++renderVersion;
        if (!source) {
          setHtml("");
          return;
        }
        const rendered = await renderMarkdown(source);
        if (currentVersion === renderVersion) {
          setHtml(rendered);
        }
      },
    ),
  );

  return <div class="markdown-preview" innerHTML={html()} />;
}
