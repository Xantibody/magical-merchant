import { createSignal, createResource, createMemo, For, Show, onMount } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { typedInvoke } from "../lib/commands";
import type { SearchHit } from "../lib/commands";
import { formatMonthDay } from "../lib/day-labels";
import { createDebouncedAccessor } from "../lib/debounce";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { toNoteItems } from "../lib/items";
import { countNoteTags, dayJumpHits, recentNoteHits } from "../lib/palette-home";
import { scopeLabel, searchRequest } from "../lib/search-scope";
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
  /** 開いた画面から引き継ぐ検索の範囲(タグ、AND)。開いた後はパレットの中で外せる。 */
  scopeTags?: string[];
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
 * search_all は全タイムライン + 全ノートのファイル走査で、実機では 1 回
 * 100ms を超えうる。打鍵ごとに発行せず、指が止まってからまとめて聞く。
 * コマンドの絞り込みはメモリ内なので query を直に見て即時に効かせる。
 */
const SEARCH_DEBOUNCE_MS = 200;

/** zero-query に出すタグの数。全部出すと入り口ではなく一覧になってしまう。 */
const HOME_TAG_LIMIT = 6;

export default function CommandPalette(props: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  // 開いた瞬間の範囲を初期値にするだけ。開いている間に外から変わることはない
  const [scope, setScope] = createSignal<string[]>(props.scopeTags ?? []);
  const [cursor, setCursor] = createSignal(0);
  // 打鍵はまとめるが、チップの付け外しは即時に効かせる。1 回の操作で結果が変わる
  const debouncedQuery = createDebouncedAccessor(query, SEARCH_DEBOUNCE_MS);
  const [hits] = createResource<SearchHit[], SearchSource>(
    () => ({ query: debouncedQuery(), tags: scope() }),
    searchHits,
  );

  /**
   * いま効いている範囲。チップに加えて、打った `#タグ` も入る(searchRequest)。
   *
   * 打った `#タグ` はチップにしない。打っている途中で `#sf` がチップになると
   * 続きが打てず、`#sf6` と `#sf` のどちらを消したいかも分からなくなる。
   * 打ったままの文字が範囲として効けばよく、消すのも文字を消すだけでいい。
   */
  const activeTags = createMemo(() => searchRequest(debouncedQuery(), scope())?.tags ?? []);

  /** 範囲は検索の入り口なので、zero-query でもチップがあれば結果を出す。 */
  const browsing = (): boolean => Boolean(query().trim() || scope().length > 0);

  let inputRef: HTMLInputElement | undefined;

  const removeScope = (tag: string): void => {
    setScope((tags) => tags.filter((candidate) => candidate !== tag));
    setCursor(0);
  };

  /** 範囲は足していく(AND)。置き換えると二つ目のタグで一つ目が消える。 */
  const addScope = (tag: string): void => {
    setScope((tags) => (tags.includes(tag) ? tags : [...tags, tag]));
    setCursor(0);
    inputRef?.focus();
  };

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
        // タグは着地先が一つに決まらないので、範囲として引き継ぐ。文字列に
        // すると本文の一致も混ざり、しかもそこから絞って打ち足せない
        run: () => addScope(tag.tag),
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
      meta: formatMonthDay(hit.date),
      highlight: splitSnippet(hit.snippet, hit.match_start, hit.match_len),
      run: () => props.onSelectHit(hit),
    }));
    // 範囲の中では件数も出す。「この中に何件あるか」が絞り込みの手応えになる
    const hitsTitle =
      activeTags().length > 0
        ? `${t().palette.hits} · ${t().palette.count(hitRows.length)}`
        : t().palette.hits;
    return [
      { title: t().palette.commands, rows: commands },
      { title: hitsTitle, rows: hitRows },
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
    // 空の入力欄で Backspace を押したら、その手前にあるチップ(最後の一つ)が消える
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

          <Show when={browsing() && !hits.loading && !hits()?.length}>
            <p class="palette-empty">
              {activeTags().length > 0
                ? t().palette.emptyScoped(scopeLabel(activeTags()))
                : t().palette.empty}
            </p>
          </Show>
        </div>
      </div>
    </div>
  );
}
