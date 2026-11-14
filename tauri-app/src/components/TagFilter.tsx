import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { t } from "../lib/i18n";
import type { TagCount } from "../lib/tags";

interface TagFilterProps {
  tags: TagCount[];
  /** The tag that was pressed. Opening search with that tag is the receiver's job. */
  onPick: (tag: string) => void;
  /**
   * While a line is being typed under them (71): the chips add their tag to the line instead,
   * and a press on one leaves the field its focus, so the keyboard stays up.
   */
  adding?: boolean;
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
 * answers, a day-grouped list in Scrawl and a list in search. While a line is typed right
 * under them, the same chips are the tags to add to it (71): no # to type on a phone.
 */
export default function TagFilter(props: TagFilterProps): JSX.Element {
  return (
    <Show when={props.tags.length}>
      {/* No label line of its own: the chips speak for themselves, and a reader gets the name */}
      <div class="tag-filter" role="group" aria-label={t().common.tags}>
        <div class="tag-filter-chips">
          <For each={props.tags}>
            {(tag) => (
              <button
                type="button"
                class="tag-chip"
                classList={{ "tag-chip--add": props.adding === true }}
                aria-label={props.adding ? t().reach.addTag(tag.tag) : undefined}
                // Typing, the press must not take the focus: the field would lose the keyboard
                onMouseDown={(e) => {
                  if (props.adding) {
                    e.preventDefault();
                  }
                }}
                onClick={() => props.onPick(tag.tag)}
              >
                #{tag.tag}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
