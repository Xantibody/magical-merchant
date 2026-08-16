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

async function loadTimeline(extraDates: string[]): Promise<TimelineItem[]> {
  const dates = await typedInvoke("list_timeline_dates");
  const wanted = [...new Set([...dates.slice(0, RECENT_DAYS), ...extraDates])].toSorted((a, b) =>
    b.localeCompare(a),
  );
  const days = await Promise.all(
    wanted.map(async (date) =>
      toTimelineItems(date, await typedInvoke("read_timeline_by_date", { date })),
    ),
  );
  return days.flat();
}

interface EntryProps {
  item: TimelineItem;
  editing: boolean;
  selecting: boolean;
  selected: boolean;
  draft: () => string;
  saved: () => boolean;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onCommit: () => void;
  onToggle: () => void;
  onPromote: () => void;
}

function Entry(props: EntryProps): JSX.Element {
  const meta = createMemo(() => entryMeta(props.item.context, places.nameOf));
  // モバイルの入り口は長押し。タップは今まで通りその場編集
  const press = createLongPress(() => props.onPromote());

  return (
    <article
      class="entry"
      classList={{ "entry--active": props.editing, "entry--selected": props.selected }}
    >
      <span class="entry-time">{props.item.time.slice(0, 5)}</span>
      <span class="entry-rail" aria-hidden="true">
        <span class="entry-rail-line" />
        <span class="entry-rail-dot" />
      </span>

      <div class="entry-body">
        <Show when={props.editing}>
          <div class="entry-editor">
            <textarea
              class="entry-editor-input"
              ref={(el) => queueMicrotask(() => el.focus())}
              value={props.draft()}
              onInput={(e) => props.onDraft(e.currentTarget.value)}
              onBlur={() => props.onCommit()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            />
            <div class="entry-editor-foot">
              <span>クリックでそのまま編集 · Esc で確定</span>
              <Show when={props.saved()}>
                <span>✓ 保存しました</span>
              </Show>
            </div>
          </div>
        </Show>

        <Show when={!props.editing && props.selecting}>
          {/* 選択モード中は本文クリックが編集ではなく選択のトグルになる */}
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

        <Show when={!props.editing && !props.selecting}>
          {/* 本文そのものが編集の入口。button なのはキーボードから開けるようにするため */}
          <button
            type="button"
            class="entry-text"
            onPointerDown={(e) => press.onPointerDown(e)}
            onPointerUp={() => press.onPointerUp()}
            onPointerMove={() => press.onPointerMove()}
            onPointerCancel={() => press.onPointerCancel()}
            onClick={() => {
              if (press.shouldClick()) {
                props.onEdit();
              }
            }}
          >
            <TagText text={props.item.text} />
          </button>
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
              title="ノートにする"
              aria-label="ノートにする"
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
          {props.filtered ? "このタグの記録はまだありません。" : "今日はまだ何も記録していません。"}
        </p>
        <p class="timeline-empty-hint">
          {props.filtered
            ? "上のチップで絞り込みを外せます。"
            : "下の入力欄に書くと、時刻とともにここに並びます。"}
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
  const [editing, setEditing] = createSignal<TimelineItem | null>(null);
  const [draft, setDraft] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  /** 選択モード。入っている間は本文クリックが編集ではなく選択になる。 */
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
  // 「1年前の今日」の判定用。読み込むのは直近だけなので、全日付は別に聞く
  const [allDates] = createResource(() => typedInvoke("list_timeline_dates"));

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

  const entries = createMemo(() => timeline() ?? []);
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
  const yearAgo = createMemo(() => yearAgoToday(today, allDates() ?? []));
  const digestVisible = createMemo(() => {
    if (isDigestDismissed(digestDismissed(), today)) {
      return false;
    }
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
  const recordedDates = createMemo(() => [...new Set((timeline() ?? []).map((i) => i.date))]);

  const contextsFor = (iso: string): (DeviceContext | null)[] =>
    (timeline() ?? []).filter((i) => i.date === iso).map((i) => i.context);

  /** 書いた日だけ読み直す。全日の読み直しは保存 1 回に日数ぶんの IPC を払う。 */
  const reloadDay = async (date: string): Promise<void> => {
    const items = toTimelineItems(date, await typedInvoke("read_timeline_by_date", { date }));
    mutate((prev) => replaceDayItems(prev ?? [], date, items));
  };

  const capture = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    await reloadDay(toIsoDate(new Date()));
  };

  // ---- その場編集（Esc / フォーカスを外すと確定）----
  const startEditing = (item: TimelineItem): void => {
    setDraft(item.text);
    setSaved(false);
    setEditing(item);
  };

  const commitEdit = async (): Promise<void> => {
    const item = editing();
    const text = draft();
    setEditing(null);
    if (!item || text === item.text) {
      return;
    }
    await typedInvoke("update_timeline_entry", { date: item.date, index: item.index, text });
    setSaved(true);
    await reloadDay(item.date);
  };

  // タブを切り替えても書きかけを捨てない。blur はアンマウントでは飛ばない。
  onCleanup(() => void commitEdit());

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

  // ---- まとめて削除（選択 → 確認 → 実行）----
  const startSelecting = (): void => {
    // 書きかけを確定してから入る。編集と選択が同時だと本文クリックの意味が曖昧になる
    void commitEdit();
    setSelecting(true);
  };

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
      await Promise.all([...new Set(plan.map((t) => t.date))].map((date) => reloadDay(date)));
      exitSelecting();
      shell.showToast(`${plan.length}件のエントリを削除しました`);
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
          <Show when={digestVisible()}>
            <section class="digest-card" aria-label="今週のふりかえり">
              <header class="digest-head">
                <span class="digest-title">今週のふりかえり</span>
                <button
                  type="button"
                  class="icon-button digest-close"
                  title="今週は閉じる"
                  aria-label="今週は閉じる"
                  onClick={dismissDigest}
                >
                  <Icon name="x" size={14} />
                </button>
              </header>
              <Show when={weekSummary().count > 0}>
                <p class="digest-line">
                  {weekSummary().days}日で{weekSummary().count}件を記録
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
                    1年前の今日の記録を見る
                  </button>
                )}
              </Show>
            </section>
          </Show>

          <TagFilter
            tags={knownTags()}
            active={tagFilter()}
            matched={visible().length}
            onToggle={setTagFilter}
          />

          <Show when={days().length} fallback={<EmptyTimeline filtered={Boolean(tagFilter())} />}>
            <div class="timeline-toolbar">
              <Show
                when={!selecting()}
                fallback={<span class="timeline-toolbar-hint">消すエントリを選んでください</span>}
              >
                <button type="button" class="timeline-toolbar-button" onClick={startSelecting}>
                  <Icon name="check-square" size={14} />
                  選択
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
                      <span class="day-heading-count">{day.items.length}件</span>
                    </header>

                    {/* この日のエントリから育ったノートへの入り口 */}
                    <Show when={originNotes().get(day.date)?.length}>
                      <div class="origin-chips">
                        <For each={originNotes().get(day.date)}>
                          {(note) => (
                            <button
                              type="button"
                              class="origin-chip"
                              onClick={() => openNote(note)}
                            >
                              <Icon name="file-text" size={13} />
                              <span class="origin-chip-title">{note.title}</span>
                              <span aria-hidden="true">→</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>

                    <For each={day.items}>
                      {(item) => (
                        <Entry
                          item={item}
                          editing={editing()?.id === item.id}
                          selecting={selecting()}
                          selected={selected().has(item.id)}
                          draft={draft}
                          saved={saved}
                          onDraft={setDraft}
                          onEdit={() => startEditing(item)}
                          onCommit={() => void commitEdit()}
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
          <div class="select-bar" role="toolbar" aria-label="まとめて削除">
            <Show
              when={confirming()}
              fallback={
                <>
                  <span class="select-bar-label">{selected().size}件選択中</span>
                  <button
                    type="button"
                    class="select-bar-danger"
                    disabled={selected().size === 0}
                    onClick={() => setConfirming(true)}
                  >
                    <Icon name="trash" size={14} />
                    削除 ({selected().size}件)
                  </button>
                  <button type="button" class="select-bar-plain" onClick={exitSelecting}>
                    キャンセル
                  </button>
                </>
              }
            >
              <span class="select-bar-label">
                {selected().size}件のエントリを削除します。よろしいですか？
              </span>
              <button
                type="button"
                class="select-bar-danger"
                disabled={deleting()}
                onClick={() => void runDelete()}
              >
                削除する
              </button>
              <button type="button" class="select-bar-plain" onClick={() => setConfirming(false)}>
                戻る
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
