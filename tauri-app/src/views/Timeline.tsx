import {
  createSignal,
  createResource,
  createMemo,
  createEffect,
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
import { typedInvoke } from "../lib/commands";
import { getClientContext } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { formatDayHeading } from "../lib/day-labels";
import { groupTimelineByDay, toTimelineItems } from "../lib/items";
import type { TimelineItem } from "../lib/items";
import { entryMeta } from "../lib/timeline-meta";
import { countTags, parseTags } from "../lib/tags";
import type { DeviceContext } from "../lib/parse-timeline";

/** 一覧に最初から載せる日数。カレンダーで遡ったぶんは都度足す。 */
const RECENT_DAYS = 14;
const UNDO_MS = 5000;

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
  deleting: boolean;
  draft: () => string;
  saved: () => boolean;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onCommit: () => void;
  onDelete: () => void;
}

function Entry(props: EntryProps): JSX.Element {
  const meta = createMemo(() => entryMeta(props.item.context));

  return (
    <article
      class="entry"
      classList={{ "entry--active": props.editing, "entry--deleting": props.deleting }}
    >
      <span class="entry-time">{props.item.time.slice(0, 5)}</span>
      <span class="entry-rail" aria-hidden="true">
        <span class="entry-rail-line" />
        <span class="entry-rail-dot" />
      </span>

      <div class="entry-body">
        <Show when={props.deleting}>
          <div class="entry-tombstone">
            <Icon name="trash" size={14} />
            エントリを削除しました
          </div>
        </Show>

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

        <Show when={!props.editing && !props.deleting}>
          <div class="entry-tools">
            <button
              type="button"
              class="entry-tool"
              title="削除"
              aria-label="削除"
              onClick={() => props.onDelete()}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
          {/* 本文そのものが編集の入口。button なのはキーボードから開けるようにするため */}
          <button type="button" class="entry-text" onClick={() => props.onEdit()}>
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
  const today = new Date();

  const [extraDates, setExtraDates] = createSignal<string[]>([]);
  /** カレンダーで選ばれた、これから見せたい日。表示できたら消す。 */
  const [jumpTo, setJumpTo] = createSignal<string | null>(null);
  /** 絞り込み中のタグ。1 つだけ選べる。 */
  const [tagFilter, setTagFilter] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<TimelineItem | null>(null);
  const [draft, setDraft] = createSignal("");
  const [saved, setSaved] = createSignal(false);
  /** 削除の取り消し待ち。5 秒経つまで本削除しないので、消えた跡だけ残す。 */
  const [pendingDelete, setPendingDelete] = createSignal<string[]>([]);

  const [timeline, { refetch }] = createResource(extraDates, loadTimeline);

  createEffect(() => {
    shell.dataVersion();
    void refetch();
  });

  const entries = createMemo(() => timeline() ?? []);
  const knownTags = createMemo(() => countTags(entries().map((item) => item.text)));

  const visible = createMemo(() => {
    const tag = tagFilter();
    if (!tag) {
      return entries();
    }
    return entries().filter((item) => parseTags(item.text).includes(tag));
  });

  const days = createMemo(() => groupTimelineByDay(visible()));

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

  const isDeleting = (id: string): boolean => pendingDelete().includes(id);

  const capture = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    await refetch();
  };

  // ---- その場編集（Esc / フォーカスを外すと確定）----
  const startEditing = (item: TimelineItem): void => {
    if (isDeleting(item.id)) {
      return;
    }
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
    await refetch();
  };

  // タブを切り替えても書きかけを捨てない。blur はアンマウントでは飛ばない。
  onCleanup(() => void commitEdit());

  // ---- 削除 + Undo（5 秒は跡だけ残し、経過後に本削除）----
  const remove = (item: TimelineItem): void => {
    setPendingDelete((ids) => [...ids, item.id]);

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_timeline_entry", { date: item.date, index: item.index });
        await refetch();
        setPendingDelete((ids) => ids.filter((id) => id !== item.id));
      })();
    }, UNDO_MS);

    shell.showToast("エントリを削除しました", () => {
      clearTimeout(commit);
      setPendingDelete((ids) => ids.filter((id) => id !== item.id));
    });
  };

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

          <Show when={days().length} fallback={<EmptyTimeline filtered={Boolean(tagFilter())} />}>
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

                    <For each={day.items}>
                      {(item) => (
                        <Entry
                          item={item}
                          editing={editing()?.id === item.id}
                          deleting={isDeleting(item.id)}
                          draft={draft}
                          saved={saved}
                          onDraft={setDraft}
                          onEdit={() => startEditing(item)}
                          onCommit={() => void commitEdit()}
                          onDelete={() => remove(item)}
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
        <CaptureBar onSend={capture} knownTags={knownTags()} />
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
