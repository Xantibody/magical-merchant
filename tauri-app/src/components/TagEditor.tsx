import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { addTag } from "../lib/note-meta";
import { isNewTag, normalizeTag, sameTag, suggestTags } from "../lib/tags";
import type { TagCount } from "../lib/tags";
import "../styles/tag-editor.css";

/** How many used tags the dropdown lists. More reads as a list to study, not a hint. */
const MAX_SUGGESTIONS = 5;

/** A press on a row or an × must not blur the input first, or the editing would end. */
function keepFocus(e: MouseEvent): void {
  e.preventDefault();
}

interface TagEditorProps {
  /** Every tag the note carries: the frontmatter's and the body's `#tag`s together. */
  tags: string[];
  /**
   * The frontmatter's tags, the only ones this can change. Undefined until they are read: an
   * edit made before that would write back a list missing the tags not yet known.
   */
  own?: string[];
  /** Tags used anywhere, most used first. */
  known: TagCount[];
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** The frontmatter's new tags. */
  onChange: (tags: string[]) => void;
  /** The phone's panel screen: chips a finger can press, always removable. */
  screen?: boolean;
}

/**
 * Tags edited where they are read, on the meta line. Pressing a `#tag` or `+ tag` turns the
 * tags into chips and puts an input after them; the dropdown offers the tags already in use.
 *
 * A tag written in the body as `#tag` shows too, but it has no ×: it lives in the body, and
 * the only honest way to remove it is there.
 */
export default function TagEditor(props: TagEditorProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);

  const isOwn = (tag: string): boolean => props.own?.some((own) => sameTag(own, tag)) ?? false;

  const suggestions = createMemo<TagCount[]>(() =>
    suggestTags(props.known, props.tags, query(), MAX_SUGGESTIONS),
  );
  const offerNew = createMemo<boolean>(() => isNewTag(props.known, props.tags, query()));
  const rows = (): number => suggestions().length + (offerNew() ? 1 : 0);

  const start = (): void => {
    setQuery("");
    setActive(0);
    props.onEditingChange(true);
  };

  const stop = (): void => {
    setQuery("");
    props.onEditingChange(false);
  };

  const add = (tag: string): void => {
    const { own } = props;
    if (!own) {
      return;
    }
    const next = addTag(own, tag);
    setQuery("");
    setActive(0);
    if (next !== own) {
      props.onChange(next);
    }
  };

  const remove = (tag: string): void => {
    const { own } = props;
    if (own) {
      props.onChange(own.filter((kept) => !sameTag(kept, tag)));
    }
  };

  const pick = (index: number): void => {
    const picked = suggestions()[index];
    add(picked ? picked.tag : normalizeTag(query()));
  };

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLInputElement }): void => {
    // The Enter that ends IME conversion is the IME's. It does not add a tag (#102)
    if (isImeComposing(e)) {
      return;
    }
    if (e.key === "ArrowDown" && rows() > 0) {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows() - 1));
    } else if (e.key === "ArrowUp" && rows() > 0) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows() > 0) {
        pick(active());
      }
    } else if (e.key === "Escape") {
      // The first Esc belongs to the input. The panel and the history wait for the next one
      e.preventDefault();
      stop();
    } else if (e.key === "Backspace" && e.currentTarget.value === "") {
      const last = props.own?.at(-1);
      if (last !== undefined) {
        e.preventDefault();
        remove(last);
      }
    }
  };

  const chip = (tag: string): JSX.Element => (
    <span class="tag-editor-chip" title={isOwn(tag) ? undefined : t().tags.fromBody}>
      #{tag}
      <Show when={isOwn(tag)}>
        <button
          type="button"
          class="tag-editor-remove"
          aria-label={t().meta.removeTag(tag)}
          onMouseDown={keepFocus}
          onClick={() => remove(tag)}
        >
          <Icon name="x" size={10} />
        </button>
      </Show>
    </span>
  );

  let input: HTMLInputElement | undefined;
  // The input opens disabled until the frontmatter's tags are read, and a disabled input cannot
  // take the caret. It is handed over the moment it can type
  createEffect(
    on(
      () => props.editing && props.own !== undefined,
      (ready) => {
        if (ready) {
          queueMicrotask(() => input?.focus());
        }
      },
    ),
  );

  const field = (): JSX.Element => (
    <span class="tag-editor-field">
      <input
        type="text"
        class="tag-editor-input"
        aria-label={t().meta.addTag}
        placeholder={t().meta.addTag}
        disabled={!props.own}
        value={query()}
        ref={(el) => {
          input = el;
        }}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={stop}
      />
      <Show when={rows() > 0}>
        <div
          class="tag-suggest tag-suggest--below"
          role="listbox"
          aria-label={t().tags.suggestLabel}
        >
          <span class="tag-suggest-label">{t().tags.suggestLabel}</span>
          <For each={suggestions()}>
            {(suggestion, i) => (
              <button
                type="button"
                role="option"
                aria-selected={active() === i()}
                class="tag-suggest-row"
                classList={{ "tag-suggest-row--active": active() === i() }}
                onMouseDown={keepFocus}
                onClick={() => add(suggestion.tag)}
              >
                <span>#{suggestion.tag}</span>
                <span class="tag-suggest-count">{suggestion.count}</span>
              </button>
            )}
          </For>
          <Show when={offerNew()}>
            <button
              type="button"
              role="option"
              aria-selected={active() === suggestions().length}
              class="tag-suggest-row tag-suggest-row--new"
              classList={{ "tag-suggest-row--active": active() === suggestions().length }}
              onMouseDown={keepFocus}
              onClick={() => add(query())}
            >
              {t().tags.addNew(normalizeTag(query()))}
            </button>
          </Show>
          <span class="tag-suggest-foot">{t().tags.footHint}</span>
        </div>
      </Show>
    </span>
  );

  return (
    <span
      class="tag-editor"
      classList={{ "tag-editor--editing": props.editing, "tag-editor--screen": props.screen }}
    >
      <Show
        when={props.editing || props.screen}
        fallback={
          <>
            <For each={props.tags}>
              {(tag) => (
                <button type="button" class="tag-editor-tag" onClick={start}>
                  #{tag}
                </button>
              )}
            </For>
            <button type="button" class="tag-editor-add" onClick={start}>
              <Icon name="plus" size={10} />
              {t().tags.addShort}
            </button>
          </>
        }
      >
        <For each={props.tags}>{chip}</For>
        <Show
          when={props.editing}
          fallback={
            <button type="button" class="tag-editor-add tag-editor-add--chip" onClick={start}>
              <Icon name="plus" size={12} />
              {t().tags.add}
            </button>
          }
        >
          {field()}
        </Show>
      </Show>
    </span>
  );
}
