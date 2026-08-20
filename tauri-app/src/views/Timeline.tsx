import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
  on,
  For,
  Show,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import Icon from "../components/Icon";
import CaptureBar from "../components/CaptureBar";
import CalendarPopover from "../components/CalendarPopover";
import TagFilter from "../components/TagFilter";
import TagText from "../components/TagText";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { typedInvoke } from "../lib/commands";
import { getClientContext } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { formatDayHeading, toIsoDate } from "../lib/day-labels";
import { t } from "../lib/i18n";
import {
  groupTimelineByDay,
  notesByOriginDate,
  planBulkDelete,
  replaceDayItems,
  toNoteItems,
  toTimelineItems,
} from "../lib/items";
import type { NoteItem, TimelineItem } from "../lib/items";
import { createLongPress } from "../lib/long-press";
import { entryMeta } from "../lib/timeline-meta";
import { places } from "../lib/places";
import { ROUTES } from "../lib/routes";
import { countTags, parseTags } from "../lib/tags";
import {
  digestWeekKey,
  isDigestDismissed,
  summarizeWeek,
  yearAgoToday,
} from "../lib/weekly-digest";
import type { DeviceContext } from "../lib/parse-timeline";

/** 一覧に最初から載せる日数。カレンダーで遡ったぶんは都度足す。 */
const RECENT_DAYS = 14;

/** 週次ダイジェストを閉じた週(月曜の日付)。端末ローカルの表示状態。 */
const DIGEST_DISMISS_KEY = "weekly-digest-dismissed";

interface TimelineData {
  items: TimelineItem[];
  /** 記録のある全日付(新しい順)。ダイジェストの「1年前の今日」判定が使う。 */
  dates: string[];
}

/**
 * 直近の日々と全日付一覧を 1 つの値で返す。別々のリソースに分けると
 * 描画が別フラッシュになり、先に出た日リストへ後からダイジェストが
 * 割り込んでレイアウトシフトを起こす。
 */
async function loadTimeline(extraDates: string[]): Promise<TimelineData> {
  const dates = await typedInvoke("list_timeline_dates");
  const wanted = [...new Set([...dates.slice(0, RECENT_DAYS), ...extraDates])].toSorted((a, b) =>
    b.localeCompare(a),
  );
  const days = await Promise.all(
    wanted.map(async (date) =>
      toTimelineItems(date, await typedInvoke("read_timeline_by_date", { date })),
    ),
  );
  return { items: days.flat(), dates };
}

interface OriginChipProps {
  note: NoteItem;
  onOpen: (note: NoteItem) => void;
  onUnlink: (note: NoteItem) => void;
}

/** 昇格ノートへの入り口。開くのがタップ、繋がりを解くのが隠しアクション。 */
function OriginChip(props: OriginChipProps): JSX.Element {
  // モバイルの解除は長押し。PC はホバーで出る × が受ける
  const press = createLongPress(() => props.onUnlink(props.note));

  return (
    <span class="origin-chip">
      <button
        type="button"
        class="origin-chip-open"
        onClick={() => {
          // 長押しで解除した直後の click で開かない
          if (press.shouldClick()) {
            props.onOpen(props.note);
          }
        }}
        onPointerDown={(e) => press.onPointerDown(e)}
        onPointerUp={() => press.onPointerUp()}
        onPointerMove={() => press.onPointerMove()}
        onPointerCancel={() => press.onPointerCancel()}
      >
        <Icon name="file-text" size={13} />
        <span class="origin-chip-title">{props.note.title}</span>
        <span class="origin-chip-arrow" aria-hidden="true">
          →
        </span>
      </button>
      <button
        type="button"
        class="origin-chip-unlink"
        title={t().timeline.unlink(props.note.title)}
        aria-label={t().timeline.unlink(props.note.title)}
        onClick={() => props.onUnlink(props.note)}
      >
        <Icon name="x" size={12} />
      </button>
    </span>
  );
}

interface EntryProps {
  item: TimelineItem;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onPromote: () => void;
}

function Entry(props: EntryProps): JSX.Element {
  const meta = createMemo(() => entryMeta(props.item.context, places.nameOf));
  // モバイルの入り口は長押し。タップには何も割り当てない
  const press = createLongPress(() => props.onPromote());

  return (
    <article class="entry" classList={{ "entry--selected": props.selected }}>
      <span class="entry-time">{props.item.time.slice(0, 5)}</span>
      <span class="entry-rail" aria-hidden="true">
        <span class="entry-rail-line" />
        <span class="entry-rail-dot" />
      </span>

      <div class="entry-body">
        <Show when={props.selecting}>
          {/* 選択モード中だけ本文がクリックできる。押すと選択のトグル */}
          <button
            type="button"
            class="entry-select"
            aria-pressed={props.selected}
            onClick={() => props.onToggle()}
          >
            <Icon name={props.selected ? "check-circle" : "circle"} size={16} />
            <span class="entry-select-text">
              <TagText text={props.item.text} />
            </span>
          </button>
        </Show>

        <Show when={!props.selecting}>
          {/* 記録は書き換えない。本文は読むだけで、触れる先はノートへの昇格だけ */}
          <p
            class="entry-text"
            onPointerDown={(e) => press.onPointerDown(e)}
            onPointerUp={() => press.onPointerUp()}
            onPointerMove={() => press.onPointerMove()}
            onPointerCancel={() => press.onPointerCancel()}
          >
            <TagText text={props.item.text} />
          </p>
          <Show when={meta().length}>
            <div class="entry-meta">
              <For each={meta()}>
                {(segment) => (
                  <span class="entry-meta-part">
                    <Icon name={segment.icon} size={12} />
                    {segment.label}
                  </span>
                )}
              </For>
            </div>
          </Show>
          {/* PC の入り口。隠しアクションの流儀どおり、ホバーでだけ現れる */}
          <div class="entry-actions">
            <button
              type="button"
              class="icon-button entry-action"
              title={t().timeline.promote}
              aria-label={t().timeline.promote}
              onClick={() => props.onPromote()}
            >
              <Icon name="note-pencil" size={15} />
            </button>
          </div>
        </Show>
      </div>
    </article>
  );
}

function EmptyTimeline(props: { filtered: boolean }): JSX.Element {
  return (
    <div class="timeline-empty">
      <span class="timeline-empty-rail" aria-hidden="true" />
      <div>
        <p class="timeline-empty-title">
          {props.filtered ? t().timeline.emptyFiltered : t().timeline.emptyToday}
        </p>
        <p class="timeline-empty-hint">
          {props.filtered ? t().timeline.emptyFilteredHint : t().timeline.emptyHint}
        </p>
      </div>
    </div>
  );
}

export default function Timeline(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = new Date();

  const [extraDates, setExtraDates] = createSignal<string[]>([]);
  /** カレンダーで選ばれた、これから見せたい日。表示できたら消す。 */
  const [jumpTo, setJumpTo] = createSignal<string | null>(null);
  /** 絞り込み中のタグ。1 つだけ選べる。 */
  const [tagFilter, setTagFilter] = createSignal<string | null>(null);
  /** 選択モード。入っている間だけ本文がクリックで選択できる。 */
  const [selecting, setSelecting] = createSignal(false);
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  /** 削除前のワンクッション。確認バーが出ている間だけ true。 */
  const [confirming, setConfirming] = createSignal(false);
  /** 削除の実行中。連打で同じ行を二度消さないための鍵。 */
  const [deleting, setDeleting] = createSignal(false);

  const [timeline, { refetch, mutate }] = createResource(extraDates, loadTimeline);
  // 昇格ノートのチップに使う。タイムラインの描画は待たない — ノート一覧が
  // 届いてからチップだけ後から現れる
  const [notes, { refetch: refetchNotes }] = createResource(async () =>
    toNoteItems(await typedInvoke("list_notes")),
  );

  // 初回は createResource が読む。defer しないとマウント直後に同じ全読みを
  // もう一度走らせ、起動時の IPC がまるごと倍になる
  createEffect(
    on(
      shell.dataVersion,
      () => {
        void refetch();
        void refetchNotes();
      },
      { defer: true },
    ),
  );

  const entries = createMemo(() => timeline()?.items ?? []);
  // 地名は記録の一部ではないので、これを待って一覧を出さない。座標のまま先に
  // 並べ、引けたものから名前に差し替わる。
  createEffect(() => void places.load(entries().map((item) => item.context)));
  const knownTags = createMemo(() => countTags(entries().map((item) => item.text)));

  const visible = createMemo(() => {
    const tag = tagFilter();
    if (!tag) {
      return entries();
    }
    return entries().filter((item) => parseTags(item.text).includes(tag));
  });

  const days = createMemo(() => groupTimelineByDay(visible()));
  const originNotes = createMemo(() => notesByOriginDate(notes() ?? []));

  // ---- 週次ダイジェスト(週に一度、閉じるまで先頭に出る)----
  const [digestDismissed, setDigestDismissed] = createSignal(
    localStorage.getItem(DIGEST_DISMISS_KEY),
  );
  const weekSummary = createMemo(() => summarizeWeek(entries(), today));
  const yearAgo = createMemo(() => yearAgoToday(today, timeline()?.dates ?? []));
  const digestVisible = createMemo(() => {
    if (isDigestDismissed(digestDismissed(), today)) {
      return false;
    }
    // items と dates は同じリソースの 1 値なので、カードと日リストは
    // 必ず同じフラッシュで描画される(後から割り込んで押し下げない)
    // 語ることが何も無い週に空のカードを出さない
    return weekSummary().count > 0 || yearAgo() !== null;
  });

  const dismissDigest = (): void => {
    const key = digestWeekKey(today);
    localStorage.setItem(DIGEST_DISMISS_KEY, key);
    setDigestDismissed(key);
  };

  const jumpToDay = (iso: string): void => {
    setExtraDates((dates) => (dates.includes(iso) ? dates : [...dates, iso]));
    setJumpTo(iso);
  };

  // 検索やパレットからの着地 (?day=)。カレンダーで選んだときと同じ経路に
  // 流す — 直近 14 日より前ならデータを足し、その日の見出しまでスクロール
  createEffect(() => {
    const { day } = searchParams;
    if (typeof day !== "string" || !day) {
      return;
    }
    setExtraDates((dates) => (dates.includes(day) ? dates : [...dates, day]));
    setJumpTo(day);
    setSearchParams({ day: undefined }, { replace: true });
  });

  /**
   * 日付を足すとデータを取り直すぶん行が作り直され、その場でスクロールしても
   * 描き直しで先頭に戻る。読み込みが終わってから動かす。
   */
  createEffect(() => {
    const iso = jumpTo();
    if (!iso || timeline.loading) {
      return;
    }
    document.querySelector(`[data-day="${iso}"]`)?.scrollIntoView({ block: "start" });
    setJumpTo(null);
  });
  const recordedDates = createMemo(() => [
    ...new Set((timeline()?.items ?? []).map((i) => i.date)),
  ]);

  const contextsFor = (iso: string): (DeviceContext | null)[] =>
    (timeline()?.items ?? []).filter((i) => i.date === iso).map((i) => i.context);

  /** 書いた日だけ読み直す。全日の読み直しは保存 1 回に日数ぶんの IPC を払う。 */
  const reloadDay = async (date: string): Promise<void> => {
    const items = toTimelineItems(date, await typedInvoke("read_timeline_by_date", { date }));
    mutate((prev) => ({
      items: replaceDayItems(prev?.items ?? [], date, items),
      dates: prev?.dates ?? [],
    }));
  };

  const capture = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    await reloadDay(toIsoDate(new Date()));
  };

  /**
   * エントリを昇格させてノートを作り、そのまま書き始められる状態で開く。
   * エントリ側のファイルには何も書かない — ノートの frontmatter `origin`
   * だけが両者を繋ぎ、チップは毎回そこから導出される。
   */
  const promote = async (item: TimelineItem): Promise<void> => {
    const path = await typedInvoke("create_draft", {
      body: item.text,
      tags: parseTags(item.text),
      origin: `${item.date}T${item.time}`,
      client: await getClientContext(),
    });
    const filename = path.split("/").at(-1);
    if (!filename) {
      return;
    }
    shell.refreshData();
    navigate(`${ROUTES.NOTES}?file=${encodeURIComponent(filename)}&edit=1`);
  };

  const openNote = (note: NoteItem): void => {
    navigate(`${ROUTES.NOTES}?file=${encodeURIComponent(note.filename)}`);
  };

  /**
   * 昇格元エントリとの関係を解く。消えるのは繋がりの記録だけで、
   * ノート本体には触れない。戻すときは同じ値を書き戻すだけなので、
   * 削除と同じく確認ではなく Undo で受ける。
   */
  const unlinkNote = async (note: NoteItem): Promise<void> => {
    const { origin } = note;
    if (!origin) {
      return;
    }
    await typedInvoke("set_note_origin", { filename: note.filename, origin: null });
    await refetchNotes();
    shell.showToast(t().timeline.unlinked, () => {
      void (async () => {
        await typedInvoke("set_note_origin", { filename: note.filename, origin });
        await refetchNotes();
      })();
    });
  };

  // ---- まとめて削除（選択 → 確認 → 実行）----
  const exitSelecting = (): void => {
    setSelecting(false);
    setSelected(new Set<string>());
    setConfirming(false);
  };

  const toggleSelected = (id: string): void => {
    // 選び直したら確認は仕切り直す。件数の変わった確認をそのまま実行させない
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const runDelete = async (): Promise<void> => {
    // 連打で同じ index を二度消させない
    if (deleting()) {
      return;
    }
    setDeleting(true);
    try {
      const ids = selected();
      const plan = planBulkDelete(entries().filter((item) => ids.has(item.id)));
      // 同じ日の index は前の削除で行が繰り上がると意味が変わるので、並列にせず順に消す
      for (const target of plan) {
        // oxlint-disable-next-line no-await-in-loop
        await typedInvoke("delete_timeline_entry", { date: target.date, index: target.index });
      }
      await Promise.all(
        [...new Set(plan.map((target) => target.date))].map((date) => reloadDay(date)),
      );
      exitSelecting();
      shell.showToast(t().timeline.deleted(plan.length));
    } finally {
      setDeleting(false);
    }
  };

  // Esc で一段ずつ戻る: 確認バー → 選択モード → 通常
  createEffect(() => {
    if (!selecting()) {
      return;
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") {
        return;
      }
      e.preventDefault();
      if (confirming()) {
        setConfirming(false);
      } else {
        exitSelecting();
      }
    };
    globalThis.addEventListener("keydown", onKey);
    onCleanup(() => globalThis.removeEventListener("keydown", onKey));
  });

  return (
    <div class="timeline">
      <div class="timeline-scroll">
        <div class="timeline-column">
          <TagFilter
            tags={knownTags()}
            active={tagFilter()}
            matched={visible().length}
            onToggle={setTagFilter}
          />

          {/* TagFilter より下に置く: 上に挿すと、データが遅れて届いたとき
              最初の描画に存在した行が押し下げられてレイアウトシフトになる。
              ここなら日リストと同じ「後から現れる領域」の先頭に収まる */}
          <Show when={digestVisible()}>
            <section class="digest-card" aria-label={t().timeline.digestTitle}>
              <header class="digest-head">
                <span class="digest-title">{t().timeline.digestTitle}</span>
                <button
                  type="button"
                  class="icon-button digest-close"
                  title={t().timeline.digestClose}
                  aria-label={t().timeline.digestClose}
                  onClick={dismissDigest}
                >
                  <Icon name="x" size={14} />
                </button>
              </header>
              <Show when={weekSummary().count > 0}>
                <p class="digest-line">
                  {t().timeline.digestSummary(weekSummary().days, weekSummary().count)}
                </p>
              </Show>
              <Show when={weekSummary().topTags.length > 0}>
                <div class="digest-tags">
                  <For each={weekSummary().topTags}>
                    {(tag) => (
                      <button
                        type="button"
                        class="digest-tag"
                        onClick={() => setTagFilter(tag.tag)}
                      >
                        #{tag.tag}
                        <span class="digest-tag-count">{tag.count}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={yearAgo()}>
                {(iso) => (
                  <button type="button" class="digest-year-ago" onClick={() => jumpToDay(iso())}>
                    <Icon name="clock-counter-clockwise" size={13} />
                    {t().timeline.lastYear}
                  </button>
                )}
              </Show>
            </section>
          </Show>

          <Show when={days().length} fallback={<EmptyTimeline filtered={Boolean(tagFilter())} />}>
            <div class="timeline-toolbar">
              <Show
                when={!selecting()}
                fallback={<span class="timeline-toolbar-hint">{t().timeline.selectHint}</span>}
              >
                <button
                  type="button"
                  class="timeline-toolbar-button"
                  onClick={() => setSelecting(true)}
                >
                  <Icon name="check-square" size={14} />
                  {t().timeline.select}
                </button>
              </Show>
            </div>

            <For each={days()}>
              {(day) => {
                const heading = createMemo(() => formatDayHeading(day.date, today));
                return (
                  <section class="day-group" data-day={day.date}>
                    <header class="day-heading">
                      <h2 class="day-heading-label">{heading().label}</h2>
                      <span class="day-heading-date">{heading().date}</span>
                      <span class="day-heading-count">
                        {t().timeline.entryCount(day.items.length)}
                      </span>
                    </header>

                    {/* この日のエントリから育ったノートへの入り口 */}
                    <Show when={originNotes().get(day.date)?.length}>
                      <div class="origin-chips">
                        <For each={originNotes().get(day.date)}>
                          {(note) => (
                            <OriginChip
                              note={note}
                              onOpen={openNote}
                              onUnlink={(target) => void unlinkNote(target)}
                            />
                          )}
                        </For>
                      </div>
                    </Show>

                    <For each={day.items}>
                      {(item) => (
                        <Entry
                          item={item}
                          selecting={selecting()}
                          selected={selected().has(item.id)}
                          onToggle={() => toggleSelected(item.id)}
                          onPromote={() => void promote(item)}
                        />
                      )}
                    </For>
                  </section>
                );
              }}
            </For>
          </Show>
        </div>
      </div>

      <div class="capture-dock">
        <Show when={selecting()} fallback={<CaptureBar onSend={capture} knownTags={knownTags()} />}>
          <div class="select-bar" role="toolbar" aria-label={t().timeline.bulkDelete}>
            <Show
              when={confirming()}
              fallback={
                <>
                  <span class="select-bar-label">
                    {t().timeline.selectedCount(selected().size)}
                  </span>
                  <button
                    type="button"
                    class="select-bar-danger"
                    disabled={selected().size === 0}
                    onClick={() => setConfirming(true)}
                  >
                    <Icon name="trash" size={14} />
                    {t().timeline.deleteCount(selected().size)}
                  </button>
                  <button type="button" class="select-bar-plain" onClick={exitSelecting}>
                    {t().common.cancel}
                  </button>
                </>
              }
            >
              <span class="select-bar-label">{t().timeline.confirmDelete(selected().size)}</span>
              <button
                type="button"
                class="select-bar-danger"
                disabled={deleting()}
                onClick={() => void runDelete()}
              >
                {t().timeline.confirmDeleteYes}
              </button>
              <button type="button" class="select-bar-plain" onClick={() => setConfirming(false)}>
                {t().common.back}
              </button>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={shell.popover() === "calendar"}>
        <div class="popover-anchor popover-anchor--calendar">
          <CalendarPopover
            recordedDates={recordedDates()}
            contextsFor={contextsFor}
            onPick={(iso) => {
              setExtraDates((dates) => (dates.includes(iso) ? dates : [...dates, iso]));
              setJumpTo(iso);
              shell.closePopovers();
            }}
          />
        </div>
      </Show>
    </div>
  );
}
