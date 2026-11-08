import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { t } from "../lib/i18n";
import type { TagCount } from "../lib/tags";

interface TagFilterProps {
  tags: TagCount[];
  /** The tag that was pressed. Opening search with that tag is the receiver's job. */
  onPick: (tag: string) => void;
}

/**
 * A row of chips, ordered from the most used tag down.
 *
 * They are something to pick from because writing wants free notation and searching wants
 * something else. Being made to recall a spelling while searching means never reaching the
 * record you were after.
 *
 * Pressing one **does not narrow in place**: it opens the search field with that tag.
 * Putting the narrowing in two places would make the same "narrow by #sync" give two
 * answers, a day-grouped list in Scrawl and a list in search.
 */
export default function TagFilter(props: TagFilterProps): JSX.Element {
  return (
    <Show when={props.tags.length}>
      <div class="tag-filter">
        <span class="tag-filter-label">{t().common.tags}</span>
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
