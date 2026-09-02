import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { glyphs, splitGlyphs } from "../lib/glyphs";
import { splitTagged } from "../lib/tags";

/**
 * 本文をそのまま出しつつ、`#タグ` にだけ色を付け、`:name:` を登録済みの
 * 画像に置き換える。
 *
 * 本文と別に並べると同じ語が 2 度出て場所を食う。書いた位置のまま示せば、
 * 何に対して付けたタグなのかも一緒に読める。
 *
 * グリフを先に切るのは、`#` の判定が `:` を語の区切りと見ないため —
 * `:236p:#fgc` のように続けて書かれても、画像とタグの両方として読める。
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
