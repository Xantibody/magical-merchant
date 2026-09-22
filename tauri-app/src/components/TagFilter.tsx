import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { TagCount } from "../lib/tags";

interface TagFilterProps {
  tags: TagCount[];
  /** The tag that was pressed. Opening Browse with that tag is the receiver's job. */
  onPick: (tag: string) => void;
}

/**
 * A row of chips, ordered from the most used tag down.
 *
 * They are something to pick from because writing wants free notation and searching wants
 * something else. Being made to recall a spelling while searching means never reaching the
 * record you were after.
 *
 * Pressing one **does not narrow in place**: it opens Browse with Scrawl and that tag.
 * Putting the narrowing in two places would make the same "narrow by #sync" give two
 * answers, a day-grouped list in Scrawl and a three-axis list in Browse.
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
