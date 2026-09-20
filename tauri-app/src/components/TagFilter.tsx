import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TagCount } from "../lib/tags";

interface TagFilterProps {
  tags: TagCount[];
  /** 押されたタグ。絞る画面をそのタグで開くのは受け取った側の仕事。 */
  onPick: (tag: string) => void;
}

/**
 * よく使うタグから順に並べたチップの行。
 *
 * 選択式にしているのは、書くときの自由記法と探すときで求めるものが違うから。
 * 探すときに綴りを思い出させると、目的の記録にたどり着けない。
 *
 * 押しても**この場では絞らない** — 絞る画面を Scrawl とそのタグで開く。
 * 絞り込みを 2 か所に置くと、同じ「#sync で絞る」が Scrawl では日ごとの
 * 一覧、絞る画面では 3 軸の一覧という 2 つの答えを返すことになる。
 */
export default function TagFilter(props: TagFilterProps): JSX.Element {
  return (
    <Show when={props.tags.length}>
      <div class="tag-filter">
        <span class="tag-filter-label">TAGS</span>
        <div class="tag-filter-chips">
          <For each={props.tags}>
            {(tag) => (
              <button type="button" class="tag-chip" onClick={() => props.onPick(tag.tag)}>
                #{tag.tag}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
