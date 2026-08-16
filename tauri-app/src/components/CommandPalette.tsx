import { createSignal, createResource, createMemo, For, Show, onMount } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { typedInvoke } from "../lib/commands";
import type { SearchHit } from "../lib/commands";
import { createDebouncedAccessor } from "../lib/debounce";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { toNoteItems } from "../lib/items";
import { countNoteTags, dayJumpHits, recentNoteHits } from "../lib/palette-home";
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
  onSelectHit: (hit: SearchHit) => void;
  onClose: () => void;
}

interface PaletteRow {
  key: string;
  icon: IconName;
  label: string;
  meta?: string;
  /** 一致箇所つきの抜粋。タイトルと同文のときは出さない。 */
  highlight?: SnippetParts | null;
  run: () => void;
}

interface PaletteSection {
  title: string;
  rows: PaletteRow[];
}

function searchHits(query: string): Promise<SearchHit[]> {
  if (!query.trim()) {
    return Promise.resolve([]);
  }
  return typedInvoke("search_all", { query });
}

/**
 * search_all は全タイムライン + 全ノートのファイル走査で、実機では 1 回
 * 100ms を超えうる。打鍵ごとに発行せず、指が止まってからまとめて聞く。
 * コマンドの絞り込みはメモリ内なので query を直に見て即時に効かせる。
 */
const SEARCH_DEBOUNCE_MS = 200;

/** zero-query に出すタグの数。全部出すと入り口ではなく一覧になってしまう。 */
const HOME_TAG_LIMIT = 6;

function monthDay(iso: string): string {
  return iso.slice(5).replace("-", "/");
}

export default function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [hits] = createResource(createDebouncedAccessor(query, SEARCH_DEBOUNCE_MS), searchHits);

  // zero-query の入り口。どれも既存の IPC から導出するだけで、開いた瞬間に
  // 1 回読めば足りる
  const [home] = createResource(async () => {
    const [notes, dates] = await Promise.all([
      typedInvoke("list_notes"),
      typedInvoke("list_timeline_dates"),
    ]);
    const items = toNoteItems(notes);
    return {
      recent: recentNoteHits(items),
      tags: countNoteTags(items).slice(0, HOME_TAG_LIMIT),
      days: dayJumpHits(dates, new Date()),
    };
  });

  let inputRef: HTMLInputElement | undefined;
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

    if (!query().trim()) {
      const entry = home();
      const days: PaletteRow[] = (entry?.days ?? []).map((day) => ({
        key: `day:${day.hit.date}`,
        icon: "calendar-blank",
        label: day.label,
        meta: monthDay(day.hit.date),
        run: () => props.onSelectHit(day.hit),
      }));
      const recent: PaletteRow[] = (entry?.recent ?? []).map((hit) => ({
        key: `recent:${hit.filename}`,
        icon: "file-text",
        label: hit.title,
        meta: monthDay(hit.date),
        run: () => props.onSelectHit(hit),
      }));
      const tags: PaletteRow[] = (entry?.tags ?? []).map((tag) => ({
        key: `tag:${tag.tag}`,
        icon: "magnifying-glass",
        label: `#${tag.tag}`,
        meta: t().palette.count(tag.count),
        run: () => {
          // タグは着地先が一つに決まらないので、検索として引き継ぐ
          setQuery(tag.tag);
          setCursor(0);
        },
      }));
      return [
        { title: t().palette.commands, rows: commands },
        { title: t().palette.dates, rows: days },
        { title: t().palette.recentNotes, rows: recent },
        { title: t().common.tags, rows: tags },
      ].filter((section) => section.rows.length > 0);
    }

    const hitRows: PaletteRow[] = (hits() ?? []).map((hit, i) => ({
      key: `hit:${i}`,
      icon: hit.kind === "note" ? "file-text" : "lightning",
      label: hit.title || hit.snippet,
      meta: monthDay(hit.date),
      highlight: splitSnippet(hit.snippet, hit.match_start, hit.match_len),
      run: () => props.onSelectHit(hit),
    }));
    return [
      { title: t().palette.commands, rows: commands },
      { title: t().palette.hits, rows: hitRows },
    ].filter((section) => section.rows.length > 0);
  });

  const flatRows = createMemo<PaletteRow[]>(() => sections().flatMap((section) => section.rows));

  const clampedCursor = createMemo(() => Math.min(cursor(), Math.max(flatRows().length - 1, 0)));

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
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
    // 変換確定の Enter は IME のもの。行の実行には使わない (#102)
    if (e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      flatRows()[clampedCursor()]?.run();
    }
  };

  /** セクションをまたいだ通し番号。↑↓ のカーソルはこの並びで動く。 */
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
          <span class="key-badge">esc</span>
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
                        <span class="palette-row-label">{row.label}</span>
                        <Show
                          when={
                            row.highlight &&
                            row.highlight.before + row.highlight.match + row.highlight.after !==
                              row.label
                              ? row.highlight
                              : undefined
                          }
                        >
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
                    </button>
                  )}
                </For>
              </>
            )}
          </For>

          <Show when={query().trim() && !hits.loading && !hits()?.length}>
            <p class="palette-empty">{t().palette.empty}</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
