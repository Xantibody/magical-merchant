import { createSignal, createEffect, on } from "solid-js";
import { renderMarkdown } from "../lib/markdown";
import type { JSX } from "solid-js";

interface MarkdownPreviewProps {
  source: string;
}

export default function MarkdownPreview(props: MarkdownPreviewProps): JSX.Element {
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
