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
import TimelineEntry, { OriginChip } from "../components/TimelineEntry";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { typedInvoke } from "../lib/commands";
import { getClientContext } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { formatDayHeading, toIsoDate } from "../lib/day-labels";
import { t } from "../lib/i18n";
import {
  groupTimelineByDay,
  notesByOrigin,
  orphanNotesByDate,
  originKeyOf,
  planBulkDelete,
  replaceDayItems,
  toNoteItems,
  toTimelineItems,
} from "../lib/items";
import type { NoteItem, TimelineItem } from "../lib/items";
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
  /** 絞り込み中のタグ。1 つだけ選べる。⌘K に引き継ぐので shell が持つ。 */
  const tagFilter = shell.timelineTag;
  const setTagFilter = shell.setTimelineTag;
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
  createEffect(() => {
    void places.load(entries().map((item) => item.context));
  });
  const knownTags = createMemo(() => countTags(entries().map((item) => item.text)));

  const visible = createMemo(() => {
    const tag = tagFilter();
    if (!tag) {
      return entries();
    }
    return entries().filter((item) => parseTags(item.text).includes(tag));
  });

  const days = createMemo(() => groupTimelineByDay(visible()));

  // エントリの日時 → ノート。チップは元のエントリの真下に付く
  const originNotes = createMemo(() => notesByOrigin(notes() ?? []));
  const notesFor = (item: TimelineItem): NoteItem[] => originNotes().get(originKeyOf(item)) ?? [];

  // 元のエントリが消えたノートだけ、これまでどおり日の見出し直下に出す
  const orphanNotes = createMemo(() => orphanNotesByDate(notes() ?? [], entries()));

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
    jumpToDay(day);
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
          {/* タグ行と週の要約はひと続きの見出し帯。列の 36px ではなく帯の中の
              14px で寄せる — 要約はタグの続きであって、独立した層ではない。
              digest を TagFilter より上に挿さないのは、データが遅れて届いたとき
              最初の描画に存在した行が押し下げられてレイアウトシフトになるから */}
          <Show when={knownTags().length > 0 || digestVisible()}>
            <div class="timeline-head">
              <TagFilter
                tags={knownTags()}
                active={tagFilter()}
                matched={visible().length}
                onToggle={setTagFilter}
              />

              <Show when={digestVisible()}>
                <section class="digest-line" aria-label={t().timeline.digestTitle}>
                  <span class="digest-label">{t().timeline.digestTitle}</span>
                  <Show when={weekSummary().count > 0}>
                    <span>
                      {t().timeline.digestSummary(weekSummary().days, weekSummary().count)}
                    </span>
                  </Show>
                  <Show when={yearAgo()}>
                    {(iso) => (
                      <>
                        {/* 中黒は要約と行き先を隔てるだけの字。読み上げには要らない */}
                        <Show when={weekSummary().count > 0}>
                          <span class="digest-sep" aria-hidden="true">
                            ·
                          </span>
                        </Show>
                        <button
                          type="button"
                          class="digest-year-ago"
                          aria-label={t().timeline.lastYearOpen}
                          onClick={() => jumpToDay(iso())}
                        >
                          {t().timeline.lastYear}
                          <span aria-hidden="true">→</span>
                        </button>
                      </>
                    )}
                  </Show>
                  <button
                    type="button"
                    class="icon-button digest-close"
                    title={t().timeline.digestClose}
                    aria-label={t().timeline.digestClose}
                    onClick={dismissDigest}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </section>
              </Show>
            </div>
          </Show>

          <Show when={days().length} fallback={<EmptyTimeline filtered={Boolean(tagFilter())} />}>
            <For each={days()}>
              {(day, index) => {
                const heading = createMemo(() => formatDayHeading(day.date, today));
                const orphans = createMemo(() => orphanNotes().get(day.date) ?? []);
                return (
                  <section class="day-group" data-day={day.date}>
                    <header class="day-heading">
                      <h2 class="day-heading-label">{heading().label}</h2>
                      <span class="day-heading-date">{heading().date}</span>
                      <span class="day-heading-count">
                        {t().timeline.entryCount(day.items.length)}
                        {/* 選択の入り口は、いま書いている日の件数の隣に字で 1 つ。
                            浮かせた専用のバーを 1 段作らない。入ったあとの操作は
                            下のバーが引き受けるので、その間は出さない */}
                        <Show when={index() === 0 && !selecting()}>
                          <span aria-hidden="true">·</span>
                          <button
                            type="button"
                            class="day-heading-select"
                            onClick={() => setSelecting(true)}
                          >
                            {t().timeline.select}
                          </button>
                        </Show>
                      </span>
                    </header>

                    {/* 元のエントリが消えたノートだけの避難先。通常のチップは
                        各エントリの真下に出る */}
                    <Show when={orphans().length}>
                      <div class="origin-chips">
                        <For each={orphans()}>
                          {(note) => (
                            <OriginChip
                              note={note}
                              onOpen={openNote}
                              onUnlink={(target) => {
                                void unlinkNote(target);
                              }}
                            />
                          )}
                        </For>
                      </div>
                    </Show>

                    <For each={day.items}>
                      {(item) => (
                        <TimelineEntry
                          item={item}
                          notes={notesFor(item)}
                          selecting={selecting()}
                          selected={selected().has(item.id)}
                          onToggle={() => toggleSelected(item.id)}
                          onPromote={() => {
                            void promote(item);
                          }}
                          onOpenNote={openNote}
                          onUnlinkNote={(note) => {
                            void unlinkNote(note);
                          }}
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
                  {/* 何も選んでいないうちは件数を数えても始まらない。
                      入り口のバーが消えたぶん、次にすることはここで言う */}
                  <span class="select-bar-label">
                    {selected().size === 0
                      ? t().timeline.selectHint
                      : t().timeline.selectedCount(selected().size)}
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
                onClick={() => {
                  void runDelete();
                }}
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
              jumpToDay(iso);
              shell.closePopovers();
            }}
          />
        </div>
      </Show>
    </div>
  );
}
