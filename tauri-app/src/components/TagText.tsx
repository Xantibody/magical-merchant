import { For } from "solid-js";
import type { JSX } from "solid-js";
import { splitTagged } from "../lib/tags";

/**
 * 本文をそのまま出しつつ、`#タグ` にだけ色を付ける。
 *
 * 本文と別に並べると同じ語が 2 度出て場所を食う。書いた位置のまま示せば、
 * 何に対して付けたタグなのかも一緒に読める。
 */
export default function TagText(props: { text: string }): JSX.Element {
  return (
    <For each={splitTagged(props.text)}>
      {(segment) => (segment.tag ? <span class="tag-inline">{segment.text}</span> : segment.text)}
    </For>
  );
}
