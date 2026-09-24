import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  For,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import Icon from "../components/Icon";
import MarkdownPreview from "../components/MarkdownPreview";
import { typedInvoke } from "../lib/commands";
import type { HitKind, SearchHit } from "../lib/commands";
import { formatMonthDay } from "../lib/day-labels";
import { glyphs } from "../lib/glyphs";
import { t } from "../lib/i18n";
import { toScrawlItems } from "../lib/items";
import { noteRoute } from "../lib/note-route";
import { formatRecordedAt } from "../lib/note-meta";
import { splitTitle } from "../lib/note-title";
import { HIT_ICONS, HIT_ROUTES, MODE_LABELS, ROUTES } from "../lib/routes";
import { deviceSegment } from "../lib/scrawl-meta";
import type { MetaSegment } from "../lib/scrawl-meta";
import { useShell } from "../lib/shell";
import { sameTag } from "../lib/tags";
import {
  BROWSE_PERIODS,
  browseSeed,
  filterHits,
  hasFilter,
  hitId,
  kindFacets,
  NO_FILTER,
  rowSnippet,
  tagFacets,
  toggleKind,
  toggleTag,
} from "../lib/browse";
import type { BrowsePeriod } from "../lib/browse";
import "../styles/browse.css";

/** Text of a period chip. Three words with no count in them, so it only looks up the table. */
function periodLabel(period: BrowsePeriod): string {
  if (period === "month") {
    return t().browse.thisMonth;
  }
  return period === "week" ? t().browse.thisWeek : t().common.all;
}

/** One record for the right column. Body and meta are read after selecting, so kept apart from the row. */
interface HitDetail {
  /** The body with the title line dropped. A Scrawl line is itself the title, so empty. */
  body: string;
  /** "2026/05/03 15:39". The row only carries the date, so the time is added here. */
  at: string;
  device: MetaSegment | null;
}

const NO_DETAIL: HitDetail = { body: "", at: "", device: null };

/**
 * Reads only the selected record. `browse_all` returns no more than a 40-character
 * excerpt, with no full body, time or device. Carrying those for every record
 * would turn the scan into "hand out every body", so only the one record shown
 * in the right column is read, each time.
 */
async function loadDetail(hit: SearchHit): Promise<HitDetail> {
  try {
    if (hit.kind === "scrawl") {
      const lines = await typedInvoke("read_scrawl_by_date", { date: hit.date });
      const entry = toScrawlItems(hit.date, lines).find((item) => item.index === hit.index);
      return {
        body: "",
        at: entry ? formatRecordedAt(`${hit.date}T${entry.time}`) : "",
        device: deviceSegment(entry?.context),
      };
    }
    if (!hit.filename) {
      return NO_DETAIL;
    }
    const { filename } = hit;
    const [read, meta] = await Promise.all([
      typedInvoke("read_note", { filename }),
      typedInvoke("read_note_meta", { filename }),
    ]);
    return {
      body: splitTitle(read.body).body,
      at: formatRecordedAt(meta.time),
      device: deviceSegment(meta.context),
    };
  } catch {
    // Something the CLI or another device deleted while nobody was looking. The
    // column just goes empty; the list is not taken down with it
    return NO_DETAIL;
  }
}

/**
 * The Browse screen: narrow by kind / tag / period. **It has no text search.** That
 * is the job of Cmd+K; this screen takes the other case, reaching a record without
 * typing a spelling you cannot recall.
 *
 * The filter and the counts are taken over every record. `browse_all` takes no
 * arguments and just returns everything; a chip's number is "the count with the
 * other axes applied", so each axis has its own population (`lib/browse.ts`).
 */
export default function Browse(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  /**
   * The scan reads every Scrawl day file and every note body. It is called once,
   * when the screen opens, and not again when a chip is pressed: everything to
   * count has already arrived here (#280). It is not wired to `dataVersion`
   * either. That signal fires every time the window regains focus, so wiring it
   * would keep re-reading the whole tree while the screen stays open.
   */
  const [all] = createResource(() => typedInvoke("browse_all"));
  const hits = createMemo<SearchHit[]>(() => all() ?? []);

  const filter = shell.browseFilter;

  const shown = createMemo(() => filterHits(hits(), filter(), today));
  const kinds = createMemo(() => kindFacets(hits(), filter(), today));
  const tags = createMemo(() => tagFacets(hits(), filter(), today));

  /** The selected record. If a new filter removes it, fall back to the first: no empty column. */
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  // Landing from a Scrawl chip or from Cmd+K. The wanted filter rides on the route (`?kind=&tag=`)
  createEffect(() => {
    const seed = browseSeed({ kind: searchParams.kind, tag: searchParams.tag });
    if (!seed) {
      return;
    }
    shell.setBrowseFilter(seed);
    setSelectedId(null);
    setSearchParams({ kind: undefined, tag: undefined }, { replace: true });
  });
  const selected = createMemo<SearchHit | null>(() => {
    const id = selectedId();
    return shown().find((hit) => hitId(hit) === id) ?? shown()[0] ?? null;
  });
  const [detail] = createResource(selected, loadDetail);

  /**
   * The table that resolves `[[ID]]` to a title, the same one the note's own view reads. The scan
   * already carries every note's filename and title, so nothing more is read for it.
   */
  const noteTitles = createMemo<ReadonlyMap<string, string>>(
    () =>
      new Map(
        hits().flatMap((hit) =>
          hit.kind !== "scrawl" && hit.filename
            ? [[hit.filename.replace(/\.md$/u, ""), hit.title] as const]
            : [],
        ),
      ),
  );

  /**
   * Whether the width allows a preview column beside the list. A narrow screen has
   * no column; pressing a row opens it right away (a handoff).
   */
  const wideEnough = globalThis.matchMedia("(min-width: 768px)");
  const [twoPane, setTwoPane] = createSignal(wideEnough.matches);
  const onWidthChange = (e: MediaQueryListEvent): void => {
    setTwoPane(e.matches);
  };
  wideEnough.addEventListener("change", onWidthChange);
  onCleanup(() => wideEnough.removeEventListener("change", onWidthChange));

  /** Opens what was found. A note is pointed at by the route as that one note, a Scrawl entry as its day. */
  const open = (hit: SearchHit): void => {
    if (hit.kind !== "scrawl" && hit.filename) {
      navigate(noteRoute(hit.kind, hit.filename));
    } else {
      navigate(`${ROUTES.SCRAWL}?day=${hit.date}`);
    }
  };

  /** A note link in the body opens the note it points at, as it does inside the note itself. */
  const onBodyClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const link = target?.closest("a.note-link");
    const file = link instanceof HTMLElement ? link.dataset.file : undefined;
    const linked = file ? hits().find((hit) => hit.filename === file) : undefined;
    if (linked) {
      open(linked);
    }
  };

  const chooseKind = (kind: HitKind): void => {
    shell.setBrowseFilter({ ...filter(), kinds: toggleKind(filter().kinds, kind) });
    setSelectedId(null);
  };
  const chooseTag = (tag: string): void => {
    shell.setBrowseFilter({ ...filter(), tags: toggleTag(filter().tags, tag) });
    setSelectedId(null);
  };
  const choosePeriod = (period: BrowsePeriod): void => {
    shell.setBrowseFilter({ ...filter(), period });
    setSelectedId(null);
  };

  return (
    <div class="browse">
      <aside class="browse-facets" aria-label={t().browse.title}>
        <h1 class="browse-title">{t().browse.title}</h1>

        <div class="browse-group" role="group" aria-label={t().browse.kind}>
          <span class="browse-group-label">{t().browse.kind}</span>
          <For each={kinds()}>
            {(facet) => (
              <button
                type="button"
                class="browse-chip"
                aria-pressed={filter().kinds.includes(facet.value)}
                onClick={() => chooseKind(facet.value)}
              >
                <Icon name={HIT_ICONS[facet.value]} size={13} />
                {MODE_LABELS[HIT_ROUTES[facet.value]]}
                <span class="browse-chip-count">{facet.count}</span>
              </button>
            )}
          </For>
        </div>

        {/* In a tree with no tags at all, only an empty group heading would remain */}
        <Show when={tags().length}>
          <div class="browse-group browse-group--tags" role="group" aria-label={t().common.tags}>
            <span class="browse-group-label">{t().common.tags}</span>
            <For each={tags()}>
              {(facet) => (
                <button
                  type="button"
                  class="browse-chip"
                  aria-pressed={filter().tags.some((own) => sameTag(own, facet.value))}
                  onClick={() => chooseTag(facet.value)}
                >
                  #{facet.value}
                  <span class="browse-chip-count">{facet.count}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Periods carry no count because the three choices are exclusive and
            "all" would be the total itself. It would be a column where one
            number means nothing */}
        <div class="browse-group" role="group" aria-label={t().browse.period}>
          <span class="browse-group-label">{t().browse.period}</span>
          <For each={BROWSE_PERIODS}>
            {(period) => (
              <button
                type="button"
                class="browse-chip"
                aria-pressed={filter().period === period}
                onClick={() => choosePeriod(period)}
              >
                {periodLabel(period)}
              </button>
            )}
          </For>
        </div>

        <Show when={hasFilter(filter())}>
          <button
            type="button"
            class="browse-clear"
            onClick={() => {
              shell.setBrowseFilter(NO_FILTER);
              setSelectedId(null);
            }}
          >
            {t().browse.clear}
          </button>
        </Show>
      </aside>

      <div class="browse-results">
        <div class="browse-list">
          <div class="browse-list-head">
            <span>{t().browse.count(shown().length)}</span>
            <span class="browse-list-order">{t().browse.newestFirst}</span>
          </div>

          <For each={shown()}>
            {(hit) => (
              <button
                type="button"
                class="browse-row"
                classList={{ "browse-row--active": twoPane() && selected() === hit }}
                onClick={() => (twoPane() ? setSelectedId(hitId(hit)) : open(hit))}
              >
                <Icon name={HIT_ICONS[hit.kind]} size={15} />
                <span class="browse-row-title">{hit.title || t().notes.untitled}</span>
                <span class="browse-row-date">{formatMonthDay(hit.date)}</span>
                {/* An excerpt that only repeats the title is not shown. One line is enough for the row */}
                <Show when={rowSnippet(hit)}>
                  {(snippet) => <span class="browse-row-snippet">{snippet()}</span>}
                </Show>
              </button>
            )}
          </For>

          {/* Do not say "nothing" until the read has finished */}
          <Show when={!all.loading && shown().length === 0}>
            <p class="browse-empty">{t().browse.empty}</p>
          </Show>
        </div>

        <Show when={twoPane() ? selected() : null} keyed>
          {(hit) => (
            <article class="browse-preview">
              <div class="browse-preview-meta">
                <Icon name={HIT_ICONS[hit.kind]} size={14} />
                <span>{MODE_LABELS[HIT_ROUTES[hit.kind]]}</span>
                <Show when={detail()?.at}>
                  <span class="browse-dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{detail()?.at}</span>
                </Show>
                <Show when={hit.tags.length}>
                  <span class="browse-dot" aria-hidden="true">
                    ·
                  </span>
                  <span class="browse-preview-tags">
                    {hit.tags.map((tag) => `#${tag}`).join(" ")}
                  </span>
                </Show>
                <Show when={detail()?.device}>
                  {(device) => (
                    <span class="browse-preview-device">
                      <Icon name={device().icon} size={12} />
                      {device().label}
                    </span>
                  )}
                </Show>
              </div>

              <h2 class="browse-preview-title">{hit.title || t().notes.untitled}</h2>
              {/* Drawn by the same renderer as a read-only note, so a heading, a list or a
                  diagram looks here as it does there, not as the stored Markdown */}
              <Show
                when={detail()?.body}
                fallback={<p class="browse-preview-empty">{t().browse.noBody}</p>}
              >
                {(body) => (
                  <div class="browse-preview-body" role="presentation" onClick={onBodyClick}>
                    <MarkdownPreview
                      source={body()}
                      noteTitles={noteTitles()}
                      glyphs={glyphs()}
                      exportStem={hit.filename?.replace(/\.md$/u, "")}
                      onError={(message) => shell.showToast(message)}
                    />
                  </div>
                )}
              </Show>

              {/* Only one destination. A Scrawl entry lives in its day, so putting
                  "open" beside "to that day" would show two buttons going to the same place */}
              <div class="browse-preview-actions">
                <button type="button" class="browse-open" onClick={() => open(hit)}>
                  {hit.kind === "scrawl" ? t().browse.toDay : t().browse.open}
                  <kbd class="browse-open-key" aria-hidden="true">
                    ↩
                  </kbd>
                </button>
              </div>
            </article>
          )}
        </Show>
      </div>
    </div>
  );
}
