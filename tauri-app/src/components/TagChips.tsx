import { createSignal, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";

interface TagChipsProps {
  tags: string[];
  onChange: (tags: string[]) => void;
}

/** カンマ区切りのテキスト欄をやめ、1 タグ 1 チップで足し引きする。 */
export default function TagChips(props: TagChipsProps): JSX.Element {
  const [adding, setAdding] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  let inputRef: HTMLInputElement | undefined;

  const commit = (): void => {
    const tag = draft().trim().replace(/^#/, "");
    setDraft("");
    setAdding(false);
    if (tag && !props.tags.includes(tag)) {
      props.onChange([...props.tags, tag]);
    }
  };

  const remove = (tag: string): void => {
    props.onChange(props.tags.filter((t) => t !== tag));
  };

  return (
    <div class="tag-chips">
      <For each={props.tags}>
        {(tag) => (
          <span class="tag-chip">
            #{tag}
            <button
              type="button"
              class="tag-chip-remove"
              aria-label={`${tag} を外す`}
              onClick={() => remove(tag)}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        )}
      </For>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            class="tag-add"
            onClick={() => {
              setAdding(true);
              queueMicrotask(() => inputRef?.focus());
            }}
          >
            <Icon name="plus" size={11} />
            タグ
          </button>
        }
      >
        <input
          ref={inputRef}
          type="text"
          class="tag-input"
          value={draft()}
          placeholder="タグ名"
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft("");
              setAdding(false);
            }
          }}
        />
      </Show>
    </div>
  );
}
