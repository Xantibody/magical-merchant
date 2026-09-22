import { createSignal, createResource, createMemo, For, Show, onMount } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { typedInvoke } from "../lib/commands";
import type { HitKind, SearchHit } from "../lib/commands";
import { formatMonthDay } from "../lib/day-labels";
import { createDebouncedAccessor } from "../lib/debounce";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { toNoteItems } from "../lib/items";
import { countNoteTags, dayJumpHits, recentNoteHits } from "../lib/palette-home";
import { scopeLabel, searchRequest } from "../lib/search-scope";
import { HIT_ICONS, MODE_LABELS, ROUTES } from "../lib/routes";
import { splitSnippet } from "../lib/snippet-highlight";
import type { SnippetParts } from "../lib/snippet-highlight";

interface PaletteCommand {
  id: string;
  label: string;
  icon: IconName;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  /** Search scope handed over from the opening screen (tags, AND). Removable inside the palette. */
  scopeTags?: string[];
  onSelectHit: (hit: SearchHit) => void;
  onClose: () => void;
}

interface PaletteRow {
  key: string;
  icon: IconName;
  label: string;
  /** The matched word inside the title. Where the underline goes; absent when nothing matched. */
  labelMatch?: SnippetParts | null;
  meta?: string;
  /** Excerpt with the match position. Not shown when the title already carries the match. */
  highlight?: SnippetParts | null;
  run: () => void;
}

interface PaletteSection {
  title: string;
  rows: PaletteRow[];
}

interface SearchSource {
  query: string;
  tags: string[];
}

function searchHits(source: SearchSource): Promise<SearchHit[]> {
  const request = searchRequest(source.query, source.tags);
  if (!request) {
    return Promise.resolve([]);
  }
  return typedInvoke("search_all", request);
}

/**
 * search_all scans the files of every Scrawl day and every note, and on a real
 * device one call can exceed 100ms. Do not issue it per keystroke; ask once the
 * fingers stop. Command filtering is in memory, so it reads query directly and
 * applies at once.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** Number of tags shown on zero-query. Showing all turns the entry point into a list. */
const HOME_TAG_LIMIT = 6;

/**
 * Order of the result groups. By how much was written: a Codex is something you
 * search for and open, Scrawl entries are many and reachable by date, so they go last.
 */
const HIT_GROUP_ORDER: HitKind[] = ["codex", "note", "scrawl"];

/**
 * Kind names for the group headings. Taken straight from the surface names
 * (`routes.ts`). They are proper nouns, spelled the same in both languages, so
 * they do not go through `t()`.
 */
const HIT_LABELS: Record<HitKind, string> = {
  scrawl: MODE_LABELS[ROUTES.SCRAWL],
  note: MODE_LABELS[ROUTES.NOTES],
  codex: MODE_LABELS[ROUTES.CODEX],
};

/**
 * Split the matched word inside the title into "before, match, after".
 *
 * The `match_start` core returns is a position inside the excerpt and cannot be
 * used on the title (the first line of the body). The title should be underlined
 * too, so the search happens here. Matching ignores case like core does, but the
 * returned spelling is the one that was written.
 */
function matchInLabel(label: string, word: string): SnippetParts | null {
  if (!word) {
    return null;
  }
  const chars = [...label];
  const hay = chars.map((char) => char.toLowerCase());
  const want = [...word].map((char) => char.toLowerCase());
  // A spelling where one character lowercases to two (ǅ to dž) shifts the
  // positions. Better no underline than one drawn one character off
  if ([...hay, ...want].some((char) => [...char].length !== 1)) {
    return null;
  }
  for (let at = 0; at + want.length <= hay.length; at += 1) {
    if (want.every((char, i) => hay[at + i] === char)) {
      return {
        before: chars.slice(0, at).join(""),
        match: chars.slice(at, at + want.length).join(""),
        after: chars.slice(at + want.length).join(""),
      };
    }
  }
  return null;
}

export default function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  // The scope at the moment of opening is only the initial value. It never changes
  // from outside while the palette is open
  const [scope, setScope] = createSignal<string[]>(props.scopeTags ?? []);
  const [cursor, setCursor] = createSignal(0);
  // Keystrokes are batched, but adding or removing a chip applies at once. One
  // action changes the results
  const debouncedQuery = createDebouncedAccessor(query, SEARCH_DEBOUNCE_MS);
  const [hits] = createResource<SearchHit[], SearchSource>(
    () => ({ query: debouncedQuery(), tags: scope() }),
    searchHits,
  );

  /**
   * The scope in effect now. Besides the chips, it includes typed `#tag` words
   * (searchRequest).
   *
   * A typed `#tag` does not become a chip. If `#sf` turned into a chip while still
   * being typed, the rest could not be typed, and it would be unclear whether
   * `#sf6` or `#sf` should be removed. The typed characters only need to act as
   * scope, and removing them is just deleting the characters.
   */
  const activeTags = createMemo(() => searchRequest(debouncedQuery(), scope())?.tags ?? []);

  /** The body search word (what remains after the typed `#tag` words). Underlines the title too. */
  const searchWord = createMemo(() => searchRequest(debouncedQuery(), scope())?.query ?? "");

  /** The scope is a search entry point, so with chips present results show even on zero-query. */
  const browsing = (): boolean => Boolean(query().trim() || scope().length > 0);

  let inputRef: HTMLInputElement | undefined;

  const removeScope = (tag: string): void => {
    setScope((tags) => tags.filter((candidate) => candidate !== tag));
    setCursor(0);
  };

  /** The scope accumulates (AND). Replacing would lose the first tag on the second. */
  const addScope = (tag: string): void => {
    setScope((tags) => (tags.includes(tag) ? tags : [...tags, tag]));
    setCursor(0);
    inputRef?.focus();
  };

  // The zero-query entry point. Everything derives from existing IPC calls, so one
  // read at the moment of opening is enough
  const [home] = createResource(async () => {
    const [notes, dates] = await Promise.all([
      typedInvoke("list_notes"),
      typedInvoke("list_scrawl_dates"),
    ]);
    const items = toNoteItems(notes);
    return {
      recent: recentNoteHits(items),
      tags: countNoteTags(items).slice(0, HOME_TAG_LIMIT),
      days: dayJumpHits(dates, new Date()),
    };
  });

  onMount(() => inputRef?.focus());

  const matchingCommands = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (!needle) {
      return props.commands;
    }
    return props.commands.filter((c) => c.label.toLowerCase().includes(needle));
  });

  const sections = createMemo<PaletteSection[]>(() => {
    const commands: PaletteRow[] = matchingCommands().map((command) => ({
      key: `cmd:${command.id}`,
      icon: command.icon,
      label: command.label,
      meta: command.shortcut,
      run: command.run,
    }));

    if (!browsing()) {
      const entry = home();
      const days: PaletteRow[] = (entry?.days ?? []).map((day) => ({
        key: `day:${day.hit.date}`,
        icon: "calendar-blank",
        label: day.label,
        meta: formatMonthDay(day.hit.date),
        run: () => props.onSelectHit(day.hit),
      }));
      const recent: PaletteRow[] = (entry?.recent ?? []).map((hit) => ({
        key: `recent:${hit.filename}`,
        icon: "file-text",
        label: hit.title,
        meta: formatMonthDay(hit.date),
        run: () => props.onSelectHit(hit),
      }));
      const tags: PaletteRow[] = (entry?.tags ?? []).map((tag) => ({
        key: `tag:${tag.tag}`,
        icon: "magnifying-glass",
        label: `#${tag.tag}`,
        meta: t().palette.count(tag.count),
        // A tag has no single landing place, so it is carried over as scope. As
        // query text it would also match bodies, and typing on from there could
        // not narrow it
        run: () => addScope(tag.tag),
      }));
      return [
        { title: t().palette.commands, rows: commands },
        { title: t().palette.dates, rows: days },
        { title: t().palette.recentNotes, rows: recent },
        { title: t().common.tags, rows: tags },
      ].filter((section) => section.rows.length > 0);
    }

    // Groups by kind rather than one flat list. A heading tells where a hit lived
    // faster than an icon on the row. The count gives a feel for how many are inside
    const found = hits() ?? [];
    const groups: PaletteSection[] = HIT_GROUP_ORDER.map((kind) => {
      const rows: PaletteRow[] = found
        .map((hit, i) => ({ hit, i }))
        .filter(({ hit }) => hit.kind === kind)
        .map(({ hit, i }) => {
          const label = hit.title || hit.snippet;
          return {
            key: `hit:${i}`,
            icon: HIT_ICONS[hit.kind],
            label,
            labelMatch: matchInLabel(label, searchWord()),
            meta: formatMonthDay(hit.date),
            highlight: splitSnippet(hit.snippet, hit.match_start, hit.match_len),
            run: () => props.onSelectHit(hit),
          };
        });
      return { title: `${HIT_LABELS[kind].toUpperCase()} · ${rows.length}`, rows };
    });
    return [{ title: t().palette.commands, rows: commands }, ...groups].filter(
      (section) => section.rows.length > 0,
    );
  });

  const flatRows = createMemo<PaletteRow[]>(() => sections().flatMap((section) => section.rows));

  const clampedCursor = createMemo(() => Math.min(cursor(), Math.max(flatRows().length - 1, 0)));

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
      return;
    }
    // Backspace in an empty field removes the chip just before it (the last one)
    const last = scope().at(-1);
    if (e.key === "Backspace" && !query() && last !== undefined) {
      e.preventDefault();
      removeScope(last);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(Math.min(clampedCursor() + 1, flatRows().length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(Math.max(clampedCursor() - 1, 0));
      return;
    }
    // The Enter that confirms a conversion belongs to the IME. It does not run the row (#102)
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      flatRows()[clampedCursor()]?.run();
    }
  };

  /** Running index across sections. The up/down cursor moves along this order. */
  const globalIndex = (row: PaletteRow): number =>
    flatRows().findIndex((candidate) => candidate.key === row.key);

  return (
    <div
      class="palette-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      <div class="palette" role="dialog" aria-modal="true" aria-label={t().palette.dialogLabel}>
        <div class="palette-input-row">
          <Icon name="magnifying-glass" size={17} />
          <For each={scope()}>
            {(tag) => (
              <button
                type="button"
                class="tag-chip tag-chip--active palette-scope"
                title={t().palette.removeScope}
                aria-label={`${t().palette.scopeTag(tag)} · ${t().palette.removeScope}`}
                onClick={() => removeScope(tag)}
              >
                #{tag}
                <Icon name="x" size={11} />
              </button>
            )}
          </For>
          <input
            ref={inputRef}
            type="text"
            class="palette-input"
            placeholder={t().header.searchPlaceholder}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setCursor(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <Show when={browsing() && !hits.loading}>
            <span class="palette-count">{t().palette.hitCount((hits() ?? []).length)}</span>
          </Show>
        </div>

        <div class="palette-results">
          <For each={sections()}>
            {(section) => (
              <>
                <div class="palette-section">{section.title}</div>
                <For each={section.rows}>
                  {(row) => (
                    <button
                      type="button"
                      class="palette-row"
                      classList={{ "palette-row--active": clampedCursor() === globalIndex(row) }}
                      onClick={() => row.run()}
                    >
                      <Icon name={row.icon} size={16} />
                      <span class="palette-row-text">
                        <span class="palette-row-label">
                          <Show when={row.labelMatch} fallback={row.label}>
                            {(parts) => (
                              <>
                                {parts().before}
                                <mark>{parts().match}</mark>
                                {parts().after}
                              </>
                            )}
                          </Show>
                        </span>
                        {/* When the title carries the match, the excerpt repeats it.
                            Only a match deeper in the body shows its surroundings */}
                        <Show when={row.labelMatch ? undefined : row.highlight}>
                          {(parts) => (
                            <span class="palette-row-snippet">
                              {parts().before}
                              <mark>{parts().match}</mark>
                              {parts().after}
                            </span>
                          )}
                        </Show>
                      </span>
                      <Show when={row.meta}>
                        {(meta) => <span class="palette-row-meta">{meta()}</span>}
                      </Show>
                      {/* Only the selected row says what pressing it does */}
                      <Show when={clampedCursor() === globalIndex(row)}>
                        <span class="palette-row-enter">↩ {t().palette.hintOpen}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>

          <Show when={browsing() && !hits.loading && !hits()?.length}>
            <p class="palette-empty">
              {activeTags().length > 0
                ? t().palette.emptyScoped(scopeLabel(activeTags()))
                : t().palette.empty}
            </p>
          </Show>
        </div>

        {/* Key hints. A touch screen has no use for them, so CSS hides them there */}
        <div class="palette-footer">
          <span>
            <kbd>↑↓</kbd> {t().palette.hintMove}
          </span>
          <span>
            <kbd>↩</kbd> {t().palette.hintOpen}
          </span>
          <span class="palette-footer-end">
            <kbd>Esc</kbd> {t().palette.hintClose}
          </span>
        </div>
      </div>
    </div>
  );
}
