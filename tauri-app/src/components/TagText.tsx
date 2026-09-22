import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { glyphs, splitGlyphs } from "../lib/glyphs";
import { splitTagged } from "../lib/tags";

/**
 * Print the body as it is, colour only the `#tag` words, and replace `:name:` with the
 * registered image.
 *
 * Listing them apart from the body prints the same word twice and takes space. Shown
 * where they were written, what the tag was put on is read along with it.
 *
 * Glyphs are cut first because the `#` test does not treat `:` as a word break: written
 * run together as `:236p:#fgc`, it still reads as both an image and a tag.
 */
export default function TagText(props: { text: string }): JSX.Element {
  return (
    <For each={splitGlyphs(props.text, glyphs())}>
      {(segment) => (
        <Show
          when={segment.name !== null && glyphs().get(segment.name)}
          fallback={
            <For each={splitTagged(segment.text)}>
              {(part) => (part.tag ? <span class="tag-inline">{part.text}</span> : part.text)}
            </For>
          }
        >
          {(url) => <img class="glyph" src={url()} alt={segment.text} draggable={false} />}
        </Show>
      )}
    </For>
  );
}
