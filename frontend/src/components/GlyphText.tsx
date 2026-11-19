import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { glyphs, splitGlyphs } from "../lib/glyphs";

/**
 * Print the text as it is, with each registered `:name:` replaced by its image. An
 * unregistered name, a time or a URL stays text (`splitGlyphs`).
 *
 * `plain` draws the text between the images; left out, it is printed as it is.
 */
export default function GlyphText(props: {
  text: string;
  plain?: (text: string) => JSX.Element;
}): JSX.Element {
  return (
    <For each={splitGlyphs(props.text, glyphs())}>
      {(segment) => (
        <Show
          when={segment.name !== null && glyphs().get(segment.name)}
          fallback={props.plain ? props.plain(segment.text) : segment.text}
        >
          {(url) => <img class="glyph" src={url()} alt={segment.text} draggable={false} />}
        </Show>
      )}
    </For>
  );
}
