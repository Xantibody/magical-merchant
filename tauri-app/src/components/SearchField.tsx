import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import KindDot from "./KindDot";
import type { IconName } from "./Icon";
import { hitId, rowSnippet } from "../lib/browse";
import { typedInvoke } from "../lib/commands";
import type { SearchHit } from "../lib/commands";
import { formatMonthDay } from "../lib/day-labels";
import { createDebouncedAccessor } from "../lib/debounce";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { HIT_ROUTES, MODE_LABELS } from "../lib/routes";
import {
  hasCondition,
  RECENT_ROWS,
  SEARCH_CAP,
  SEARCH_KINDS,
  SEARCH_PERIODS,
  searchArgs,
} from "../lib/search-condition";
import type { SearchCondition, SearchKind, SearchPeriod } from "../lib/search-condition";
import { searchRequest } from "../lib/search-scope";
import { matchInLabel, splitSnippet } from "../lib/snippet-highlight";

export interface SearchFieldCommand {
  id: string;
  label: string;
  icon: IconName;
  shortcut: string;
  run: () => void;
}

interface SearchFieldProps {
  /** What it opens with. A tag pressed somewhere arrives here. */
  seed: { tags?: string[] };
  commands: SearchFieldCommand[];
  /** The one thing a result does. */
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}

/** Same as the palette: a search reads every file, so it waits for the fingers to stop. */
const SEARCH_DEBOUNCE_MS = 200;

function kindLabel(kind: SearchKind): string {
  if (kind === "all") {
    return t().common.all;
  }
  return kind === "scrawl" ? t().search.kindScrawl : MODE_LABELS[HIT_ROUTES[kind]];
}

function periodLabel(period: SearchPeriod): string {
  if (period === "today") {
    return t().search.today;
  }
  return period === "week" ? t().search.thisWeek : t().search.yearAgo;
}

/** With nothing asked yet the field shows the newest records, so it can be browsed by hand. */
async function runSearch(condition: SearchCondition): Promise<SearchHit[]> {
  const args = searchArgs(condition, new Date());
  if (args) {
    return typedInvoke("search_records", args);
  }
  const all = await typedInvoke("browse_all");
  return all.slice(0, RECENT_ROWS);
}

/** What a row says under its title: the surroundings of the match, or else the start of the body. */
function HitExcerpt(props: { hit: SearchHit; word: string }): JSX.Element {
  const label = (): string => props.hit.title || props.hit.snippet;
  const inTitle = createMemo(() => matchInLabel(label(), props.word));
  const inBody = createMemo(() =>
    splitSnippet(props.hit.snippet, props.hit.match_start, props.hit.match_len),
  );
  return (
    <span class="palette-row-text">
      <span class="palette-row-label">
        <Show when={inTitle()} fallback={label()}>
          {(parts) => (
            <>
              {parts().before}
              <mark>{parts().match}</mark>
              {parts().after}
            </>
          )}
        </Show>
      </span>
      <Show
        when={inBody()}
        fallback={
          <Show when={rowSnippet(props.hit)}>
            {(rest) => <span class="palette-row-snippet">{rest()}</span>}
          </Show>
        }
      >
        {(parts) => (
          <Show when={!inTitle()}>
            <span class="palette-row-snippet">
              {parts().before}
              <mark>{parts().match}</mark>
              {parts().after}
            </span>
          </Show>
        )}
      </Show>
    </span>
  );
}

/**
 * The search field: hidden until typing, ⌘K or `/ 探す` calls it, gone again on Esc. It
 * opens on the newest records and the chips; a condition changes the list on its own, and the
 * only thing a result does is open.
 *
 * It floats over the screen rather than replacing the route. A Note being written stays
 * mounted underneath, with its caret and its unsaved text, and Esc returns to it.
 *
 * Commands are not results (ADR 0002's open item): they answer only a bare word, sit apart
 * above the records, and Enter stays on the first record unless the arrows move up to them.
 */
export default function SearchField(props: SearchFieldProps): JSX.Element {
  // The seed is only the first value; the field owns the condition from there
  const [text, setText] = createSignal("");
  const [tags, setTags] = createSignal<string[]>(props.seed.tags ?? []);
  const [kind, setKind] = createSignal<SearchKind>("all");
  const [period, setPeriod] = createSignal<SearchPeriod | null>(null);
  const [cursor, setCursor] = createSignal<number | null>(null);
  const word = createDebouncedAccessor(text, SEARCH_DEBOUNCE_MS);

  const condition = (): SearchCondition => ({
    text: text(),
    tags: tags(),
    kind: kind(),
    period: period(),
  });
  const listing = (): boolean => hasCondition(condition());

  const [hits] = createResource(
    () => ({ text: word(), tags: tags(), kind: kind(), period: period() }),
    runSearch,
  );
  const found = (): SearchHit[] => hits.latest ?? [];
  /** Whether what is on screen answers what is in the field. */
  const settled = (): boolean => word() === text() && !hits.loading;

  const searchWord = createMemo(() => searchRequest(word(), [])?.query ?? "");

  const commands = createMemo(() => {
    const needle = text().trim().toLowerCase();
    if (!needle || tags().length > 0 || kind() !== "all" || period()) {
      return [];
    }
    return props.commands.filter((command) => command.label.toLowerCase().includes(needle));
  });

  const rowCount = (): number => commands().length + found().length;
  const firstRecord = (): number => (found().length > 0 ? commands().length : 0);
  const active = createMemo(() => Math.min(cursor() ?? firstRecord(), Math.max(rowCount() - 1, 0)));

  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  const opener = document.activeElement;

  // Focus moves inside the keydown that opened it, so that key's character lands in the input
  onMount(() => inputRef?.focus());

  createEffect(() => {
    listRef
      ?.querySelector(`[data-row="${String(active())}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });

  /** Only Esc and the × go back. After opening a record, the keys belong to that record. */
  const dismiss = (): void => {
    props.onClose();
    if (opener instanceof HTMLElement) {
      opener.focus({ preventScroll: true });
    }
  };

  /** Every change of condition sends the choice back to the first record. */
  const narrow = (change: () => void): void => {
    change();
    setCursor(null);
    inputRef?.focus();
  };

  const runRow = (index: number): void => {
    const command = commands()[index];
    if (command) {
      props.onClose();
      command.run();
      return;
    }
    const hit = found()[index - commands().length];
    if (hit) {
      props.onOpen(hit);
    }
  };

  const move = (step: number): void => {
    setCursor(Math.min(Math.max(active() + step, 0), Math.max(rowCount() - 1, 0)));
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (isImeComposing(e)) {
      return;
    }
    const last = tags().at(-1);
    const inInput = e.target === inputRef;
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Backspace" && inInput && !text() && last !== undefined) {
      e.preventDefault();
      narrow(() => setTags((own) => own.slice(0, -1)));
    } else if (e.key === "Enter" && inInput) {
      e.preventDefault();
      // Before the results land, the first row is not what Enter was aimed at
      if (settled()) {
        runRow(active());
      }
    }
  };

  /** The pointer must not take the focus: an empty field closes when it loses it. */
  const keepFocus = (e: MouseEvent): void => {
    if (e.target !== inputRef) {
      e.preventDefault();
    }
  };

  /** An empty field left behind would sit over the screen with nothing to say. */
  const onFocusOut = (e: FocusEvent & { currentTarget: HTMLDivElement }): void => {
    const next = e.relatedTarget;
    if (!listing() && !(next instanceof Node && e.currentTarget.contains(next))) {
      props.onClose();
    }
  };

  const countLabel = (): string =>
    found().length >= SEARCH_CAP
      ? t().search.capped(found().length)
      : t().palette.hitCount(found().length);

  return (
    <div
      class="search"
      role="presentation"
      onMouseDown={keepFocus}
      onKeyDown={onKeyDown}
      onFocusOut={onFocusOut}
    >
      <div class="search-head">
        <div class="search-input-row">
          <Icon name="magnifying-glass" size={16} />
          <input
            ref={inputRef}
            type="search"
            class="search-input"
            placeholder={t().search.placeholder}
            aria-label={t().search.placeholder}
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setCursor(null);
            }}
          />
          <For each={tags()}>
            {(tag) => (
              <button
                type="button"
                class="tag-chip tag-chip--active search-tag"
                title={t().palette.removeScope}
                aria-label={`${t().palette.scopeTag(tag)} · ${t().palette.removeScope}`}
                onClick={() => narrow(() => setTags((own) => own.filter((one) => one !== tag)))}
              >
                #{tag}
                <Icon name="x" size={11} />
              </button>
            )}
          </For>
          <Show when={listing() && settled()}>
            <span class="palette-count">{countLabel()}</span>
          </Show>
          <button
            type="button"
            class="icon-button"
            title={t().search.close}
            aria-label={t().search.close}
            onClick={dismiss}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div class="search-chips">
          <div class="search-chip-group" role="group" aria-label={t().browse.kind}>
            <For each={SEARCH_KINDS}>
              {(one) => (
                <button
                  type="button"
                  class="search-chip"
                  aria-pressed={kind() === one}
                  onClick={() => narrow(() => setKind(one))}
                >
                  {kindLabel(one)}
                </button>
              )}
            </For>
          </div>
          <span class="search-chip-rule" aria-hidden="true" />
          <div class="search-chip-group" role="group" aria-label={t().browse.period}>
            <For each={SEARCH_PERIODS}>
              {(one) => (
                <button
                  type="button"
                  class="search-chip"
                  aria-pressed={period() === one}
                  onClick={() => narrow(() => setPeriod((own) => (own === one ? null : one)))}
                >
                  {periodLabel(one)}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      <div ref={listRef} class="search-results">
        <div class="search-column">
          <Show when={commands().length > 0}>
            <div class="palette-section">{t().palette.commands}</div>
          </Show>
          <For each={commands()}>
            {(command, i) => (
              <button
                type="button"
                class="palette-row"
                classList={{ "palette-row--active": active() === i() }}
                data-row={i()}
                onClick={() => runRow(i())}
              >
                <Icon name={command.icon} size={16} />
                <span class="palette-row-text">
                  <span class="palette-row-label">{command.label}</span>
                </span>
                <span class="palette-row-meta">{command.shortcut}</span>
              </button>
            )}
          </For>
          <Show when={commands().length > 0 && found().length > 0}>
            <div class="palette-section">{t().search.records}</div>
          </Show>
          <For each={found()}>
            {(hit, i) => {
              const row = (): number => commands().length + i();
              return (
                <button
                  type="button"
                  class="palette-row"
                  classList={{ "palette-row--active": active() === row() }}
                  data-row={row()}
                  data-hit={hitId(hit)}
                  onClick={() => runRow(row())}
                >
                  <KindDot kind={hit.kind} />
                  <HitExcerpt hit={hit} word={searchWord()} />
                  <span class="palette-row-meta">{formatMonthDay(hit.date)}</span>
                  <Show when={active() === row()}>
                    <span class="palette-row-enter">↩ {t().palette.hintOpen}</span>
                  </Show>
                </button>
              );
            }}
          </For>
          <Show when={listing() && settled() && rowCount() === 0}>
            <p class="search-empty">{t().search.empty}</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
