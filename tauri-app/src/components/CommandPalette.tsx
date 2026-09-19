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
  /** 開いた画面から引き継ぐ検索の範囲(タグ、AND)。開いた後はパレットの中で外せる。 */
  scopeTags?: string[];
  onSelectHit: (hit: SearchHit) => void;
  onClose: () => void;
}

interface PaletteRow {
  key: string;
  icon: IconName;
  label: string;
  /** 題の中の一致語。下線を引く場所で、当たっていなければ無い。 */
  labelMatch?: SnippetParts | null;
  meta?: string;
  /** 一致箇所つきの抜粋。題で当たっているときは出さない。 */
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
 * search_all は全 Scrawl + 全ノートのファイル走査で、実機では 1 回
 * 100ms を超えうる。打鍵ごとに発行せず、指が止まってからまとめて聞く。
 * コマンドの絞り込みはメモリ内なので query を直に見て即時に効かせる。
 */
const SEARCH_DEBOUNCE_MS = 200;

/** zero-query に出すタグの数。全部出すと入り口ではなく一覧になってしまう。 */
const HOME_TAG_LIMIT = 6;

/**
 * 結果の束の並び。書いた量の多い順 — Codex は探して開くもの、Scrawl は
 * 数が多く日付で辿れるものなので、下に置く。
 */
const HIT_GROUP_ORDER: HitKind[] = ["codex", "note", "scrawl"];

/**
 * 束の見出しに出す種類の名。面の名をそのまま引く(`routes.ts`)。固有名詞なので
 * どちらの言語でも同じ綴りで、`t()` は通らない。
 */
const HIT_LABELS: Record<HitKind, string> = {
  scrawl: MODE_LABELS[ROUTES.SCRAWL],
  note: MODE_LABELS[ROUTES.NOTES],
  codex: MODE_LABELS[ROUTES.CODEX],
};

/**
 * 題の中の一致語を「前・一致・後」に分ける。
 *
 * core が返す `match_start` は抜粋の中の位置で、題(本文の 1 行目)には使えない。
 * 題にも下線を引きたいので、ここで探す。突き合わせは core と同じく大小を
 * 無視するが、返す綴りは書いた形のまま。
 */
function matchInLabel(label: string, word: string): SnippetParts | null {
  if (!word) {
    return null;
  }
  const chars = [...label];
  const hay = chars.map((char) => char.toLowerCase());
  const want = [...word].map((char) => char.toLowerCase());
  // 小文字にすると 1 文字が 2 文字になる綴り(ǅ → dž)があると位置がずれる。
  // 下線を 1 文字ずらして引くより、引かないほうがいい
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

  /** 本文の検索語(打った `#タグ` を除いた残り)。題の下線もこれで引く。 */
  const searchWord = createMemo(() => searchRequest(debouncedQuery(), scope())?.query ?? "");

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

    // 1 本の並びではなく種類の束にする。どこに居たものかは、行の印より
    // 見出しのほうが早い。件数は「この中に何件あるか」の手応え
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
                        {/* 題で当たっているなら抜粋は同じことの繰り返し。
                            本文の奥で当たったときだけ、その前後を出す */}
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
