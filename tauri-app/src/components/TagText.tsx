import { For } from "solid-js";
import type { JSX } from "solid-js";
import { splitTagged } from "../lib/tags";
import GlyphText from "./GlyphText";

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
    <GlyphText
      text={props.text}
      plain={(text) => (
        <For each={splitTagged(text)}>
          {(part) => (part.tag ? <span class="tag-inline">{part.text}</span> : part.text)}
        </For>
      )}
    />
  );
}
