import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { TagCount } from "../lib/tags";

interface TagFilterProps {
  tags: TagCount[];
  active: string | null;
  /** 絞り込んだ結果の件数。効いていることを数で示す。 */
  matched: number;
  onToggle: (tag: string | null) => void;
}

/**
 * よく使うタグから順に並べた絞り込みチップ。
 *
 * 選択式にしているのは、書くときの自由記法と探すときで求めるものが違うから。
 * 探すときに綴りを思い出させると、目的の記録にたどり着けない。
 */
export default function TagFilter(props: TagFilterProps): JSX.Element {
  return (
    <Show when={props.tags.length}>
      <div class="tag-filter">
        <span class="tag-filter-label">TAGS</span>
        <div class="tag-filter-chips">
          <For each={props.tags}>
            {(tag) => (
              <button
                type="button"
                class="tag-chip"
                classList={{ "tag-chip--active": props.active === tag.tag }}
                onClick={() => props.onToggle(props.active === tag.tag ? null : tag.tag)}
              >
                #{tag.tag}
                <Show when={props.active === tag.tag}>
                  <Icon name="x" size={11} />
                </Show>
              </button>
            )}
          </For>
        </div>

        <Show when={props.active}>
          {(active) => (
            <span class="tag-filter-status">
              #{active()} で絞り込み中 · {props.matched}件
              <button type="button" class="link-button" onClick={() => props.onToggle(null)}>
                すべて
              </button>
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
}
