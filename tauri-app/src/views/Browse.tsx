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
import { typedInvoke } from "../lib/commands";
import type { HitKind, SearchHit } from "../lib/commands";
import { formatMonthDay } from "../lib/day-labels";
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

/** 期間のチップの字。数の入らない 3 語なので、表を引くだけ。 */
function periodLabel(period: BrowsePeriod): string {
  if (period === "month") {
    return t().browse.thisMonth;
  }
  return period === "week" ? t().browse.thisWeek : t().common.all;
}

/** 右の欄に出す 1 件ぶん。全文とメタは選んでから読むので、行とは別に持つ。 */
interface HitDetail {
  /** 題の行を落とした本文。Scrawl の 1 行はそれ自体が題なので空。 */
  body: string;
  /** 「2026/05/03 15:39」。行が持つのは日付までなので、ここで時刻まで足す。 */
  at: string;
  device: MetaSegment | null;
}

const NO_DETAIL: HitDetail = { body: "", at: "", device: null };

/**
 * 選んだ 1 件だけを読む。`browse_all` が返すのは先頭 40 字の抜粋までで、
 * 全文も時刻も端末も持っていない — 全件ぶん抱えると走査が「全文を配る」
 * ことになるので、右の欄に出す 1 件だけをその都度読む。
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
    // 目を離しているあいだに CLI や他の端末が消したもの。欄が空になるだけで、
    // 一覧ごと落とさない
    return NO_DETAIL;
  }
}

/**
 * 種類 / タグ / 期間で絞る画面。**文字列で探す仕掛けは持たない** — それは
 * ⌘K の仕事で、ここは「思い出せない綴りを打たずに辿り着く」ほうを引き受ける。
 *
 * 絞り込みと件数は全件から数える。`browse_all` は引数を取らず全件を返すだけ
 * で、チップの数字は「他の軸を掛けたうえでの件数」なので軸ごとに母集団が
 * 違う(`lib/browse.ts`)。
 */
export default function Browse(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  /**
   * 走査は Scrawl の全日ファイルと全ノートの本文を読む。呼ぶのは画面を開いた
   * ときの 1 回だけで、チップを押しても呼び直さない — 数えるのは全部ここに
   * 届いている(#280)。`dataVersion` にも繋げていない。窓に戻るたびに合図が
   * 来るので、繋ぐと画面を開いたまま全ツリーを読み直し続けることになる。
   */
  const [all] = createResource(() => typedInvoke("browse_all"));
  const hits = createMemo<SearchHit[]>(() => all() ?? []);

  const filter = shell.browseFilter;

  const shown = createMemo(() => filterHits(hits(), filter(), today));
  const kinds = createMemo(() => kindFacets(hits(), filter(), today));
  const tags = createMemo(() => tagFacets(hits(), filter(), today));

  /** 選んだ 1 件。絞り直して消えたら先頭に戻る — 空の欄を出しておかない。 */
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  // Scrawl のチップと ⌘K からの着地。開きたい形は道に載っている(`?kind=&tag=`)
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
   * プレビュー欄を並べられる幅か。狭い画面では列を持たず、行を押したら
   * その場で開く(ハンドオフ)。
   */
  const wideEnough = globalThis.matchMedia("(min-width: 768px)");
  const [twoPane, setTwoPane] = createSignal(wideEnough.matches);
  const onWidthChange = (e: MediaQueryListEvent): void => {
    setTwoPane(e.matches);
  };
  wideEnough.addEventListener("change", onWidthChange);
  onCleanup(() => wideEnough.removeEventListener("change", onWidthChange));

  /** 見つけたものを開く。ノートはその 1 件を、Scrawl はその日を道で指す。 */
  const open = (hit: SearchHit): void => {
    if (hit.kind !== "scrawl" && hit.filename) {
      navigate(noteRoute(hit.kind, hit.filename));
    } else {
      navigate(`${ROUTES.SCRAWL}?day=${hit.date}`);
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

        {/* タグが 1 つも無いツリーでは、空の群見出しだけが残る */}
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

        {/* 期間に件数を添えないのは、3 択が排他で「すべて」が総数そのもの
            になるから。数字が 1 つだけ意味を持たない列になる */}
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
                {/* 題と同じことしか言わない抜粋は出さない。行は 1 段で足りる */}
                <Show when={rowSnippet(hit)}>
                  {(snippet) => <span class="browse-row-snippet">{snippet()}</span>}
                </Show>
              </button>
            )}
          </For>

          {/* 読み終わるまでは「無い」と言わない */}
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
              <p class="browse-preview-body">{detail()?.body || t().browse.noBody}</p>

              {/* 行き先は 1 つだけ。Scrawl のエントリが住んでいるのはその日で、
                  「開く」と「その日へ」を並べると同じ場所へ行くボタンが 2 つ出る */}
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
