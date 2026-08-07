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
import MarkdownPreview from "../components/MarkdownPreview";
import MilkdownEditor from "../components/MilkdownEditor";
import TagChips from "../components/TagChips";
import { typedInvoke } from "../lib/commands";
import { getClientContext, getDeviceSignals } from "../lib/client-context";
import { useShell } from "../lib/shell";
import { formatDateTime } from "../lib/day-labels";
import {
  groupNotes,
  groupTimeline,
  itemMeta,
  itemTitle,
  toNoteItems,
  toTimelineItems,
} from "../lib/items";
import type { Item, ItemGroup, NoteItem, TimelineItem } from "../lib/items";
import { getBatteryIcon, getNetworkIcon, getOsLabel } from "../lib/parse-timeline";
import type { DeviceContext } from "../lib/parse-timeline";

type Tab = "timeline" | "notes";

interface WorkspaceProps {
  tab: Tab;
}

/** 一覧に最初から載せる日数。カレンダーで遡ったぶんは都度足す。 */
const RECENT_DAYS = 14;
const UNDO_MS = 5000;
const SAVE_DEBOUNCE_MS = 1000;

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

async function loadNotes(): Promise<NoteItem[]> {
  return toNoteItems(await typedInvoke("list_notes"));
}

export default function Workspace(props: WorkspaceProps): JSX.Element {
  const shell = useShell();
  const today = new Date();

  const [extraDates, setExtraDates] = createSignal<string[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  const [hidden, setHidden] = createSignal<string[]>([]);
  const [noteBody, setNoteBody] = createSignal("");

  const [timeline, { refetch: refetchTimeline }] = createResource(extraDates, loadTimeline);
  const [notes, { refetch: refetchNotes }] = createResource(loadNotes);

  // 同期やパレット操作の後にデータを取り直す
  createEffect(() => {
    shell.dataVersion();
    void refetchTimeline();
    void refetchNotes();
  });

  const visibleItems = createMemo<Item[]>(() => {
    const dropped = new Set(hidden());
    const items: Item[] = props.tab === "timeline" ? (timeline() ?? []) : (notes() ?? []);
    return items.filter((item) => !dropped.has(item.id));
  });

  const groups = createMemo<ItemGroup[]>(() =>
    props.tab === "timeline"
      ? groupTimeline(visibleItems() as TimelineItem[], today)
      : groupNotes(visibleItems() as NoteItem[], today),
  );

  const selected = createMemo<Item | undefined>(() => {
    const items = visibleItems();
    return items.find((item) => item.id === selectedId()) ?? items[0];
  });

  const recordedDates = createMemo(() => [...new Set((timeline() ?? []).map((i) => i.date))]);

  const contextsFor = (iso: string): (DeviceContext | null)[] =>
    (timeline() ?? []).filter((i) => i.date === iso).map((i) => i.context);

  // ---- 選択中ノートの本文を読む ----
  createEffect(() => {
    const item = selected();
    if (item?.kind !== "note") {
      setNoteBody("");
      return;
    }
    void (async () => {
      setNoteBody(await typedInvoke("read_note", { filename: item.filename }));
    })();
  });

  const select = (item: Item): void => {
    shell.closePopovers();
    setSelectedId(item.id);
    setEditing(false);
    setDetailOpen(true);
  };

  // ---- 記録 ----
  const capture = async (text: string): Promise<void> => {
    await typedInvoke("save_quick_capture", { text, client: await getClientContext() });
    await refetchTimeline();
  };

  // ---- 編集（自動保存: 1秒 debounce + 直列化）----
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveChain: Promise<void> = Promise.resolve();

  const flushSave = (): Promise<void> => {
    const item = selected();
    const body = draft();
    const previous = saveChain;
    saveChain = (async () => {
      await previous;
      if (!item) {
        return;
      }
      setSaveStatus("saving");
      try {
        if (item.kind === "timeline") {
          await typedInvoke("update_timeline_entry", {
            date: item.date,
            index: item.index,
            text: body,
          });
          await refetchTimeline();
        } else {
          await typedInvoke("update_draft", {
            filePath: item.path,
            body,
            tags: item.tags,
            client: await getDeviceSignals(),
          });
          await refetchNotes();
        }
        setSaveStatus("saved");
      } catch {
        setSaveStatus("idle");
      }
    })();
    return saveChain;
  };

  const scheduleSave = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
  };

  onCleanup(() => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      void flushSave();
    }
  });

  const startEditing = (): void => {
    const item = selected();
    if (!item) {
      return;
    }
    setDraft(item.kind === "timeline" ? item.text : noteBody());
    setSaveStatus("idle");
    setEditing(true);
  };

  const stopEditing = async (): Promise<void> => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    await flushSave();
    setEditing(false);
  };

  const updateTags = (item: NoteItem, tags: string[]): void => {
    void (async () => {
      await typedInvoke("update_draft", {
        filePath: item.path,
        body: noteBody(),
        tags,
        client: await getDeviceSignals(),
      });
      await refetchNotes();
    })();
  };

  // ---- 削除 + Undo（5秒は tombstone、経過後に本削除）----
  const remove = (item: Item): void => {
    setHidden((ids) => [...ids, item.id]);
    setEditing(false);

    const commit = setTimeout(() => {
      void (async () => {
        if (item.kind === "timeline") {
          await typedInvoke("delete_timeline_entry", { date: item.date, index: item.index });
          await refetchTimeline();
        } else {
          await typedInvoke("delete_note", { filename: item.filename });
          await refetchNotes();
        }
        setHidden((ids) => ids.filter((id) => id !== item.id));
      })();
    }, UNDO_MS);

    shell.showToast(
      item.kind === "note" ? "ノートを削除しました" : "エントリを削除しました",
      () => {
        clearTimeout(commit);
        setHidden((ids) => ids.filter((id) => id !== item.id));
      },
    );
  };

  const promote = (item: TimelineItem): void => {
    void (async () => {
      await typedInvoke("create_draft", {
        body: item.text,
        tags: [],
        client: await getDeviceSignals(),
      });
      await typedInvoke("delete_timeline_entry", { date: item.date, index: item.index });
      await Promise.all([refetchTimeline(), refetchNotes()]);
      shell.showToast("ノートに変換しました");
    })();
  };

  return (
    <div class="workspace" classList={{ "workspace--detail": detailOpen() }}>
      <div class="list-pane">
        <div class="list-pane-head">
          <span class="list-pane-title">{props.tab === "timeline" ? "TIMELINE" : "NOTES"}</span>
          <button
            type="button"
            class="calendar-button"
            aria-label="日付ジャンプ"
            aria-expanded={shell.popover() === "calendar"}
            onClick={() => shell.togglePopover("calendar")}
          >
            <Icon name="calendar-blank" size={15} />
            {today.getMonth() + 1}月
          </button>

          <Show when={shell.popover() === "calendar"}>
            <CalendarPopover
              recordedDates={recordedDates()}
              contextsFor={contextsFor}
              onPick={(iso) => {
                setExtraDates((dates) => (dates.includes(iso) ? dates : [...dates, iso]));
                const match = visibleItems().find((item) => item.date === iso);
                if (match) {
                  setSelectedId(match.id);
                }
              }}
            />
          </Show>
        </div>

        <div class="list-scroll">
          <Show when={groups().length} fallback={<p class="empty-state">まだ記録がありません</p>}>
            <For each={groups()}>
              {(group) => (
                <>
                  <div class="list-group-label">{group.label}</div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        class="list-row"
                        classList={{ "list-row--selected": selected()?.id === item.id }}
                        onClick={() => select(item)}
                      >
                        <span class="list-row-title">{itemTitle(item)}</span>
                        <span class="list-row-meta">{itemMeta(item)}</span>
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </Show>
        </div>
      </div>

      <div class="detail-pane">
        <Show when={selected()} fallback={<div class="detail-empty">項目がありません</div>}>
          {(item) => (
            <>
              <div class="detail-meta-bar">
                <button
                  type="button"
                  class="icon-button detail-back"
                  aria-label="一覧に戻る"
                  onClick={() => setDetailOpen(false)}
                >
                  <Icon name="arrow-left" size={18} />
                </button>
                <span class="detail-meta">
                  {formatDateTime(item().date, item().time)}
                  <Show when={item().kind === "timeline" && (item() as TimelineItem).context}>
                    {(context) => (
                      <span class="detail-context">
                        <Show when={getBatteryIcon(context())}>
                          {(icon) => <Icon name={icon()} size={13} />}
                        </Show>
                        <Show when={getNetworkIcon(context())}>
                          {(icon) => <Icon name={icon()} size={13} />}
                        </Show>
                        <Show when={getOsLabel(context())}>
                          {(label) => (
                            <>
                              <Icon
                                name={context().os === "android" ? "device-mobile" : "laptop"}
                                size={13}
                              />
                              {label()}
                            </>
                          )}
                        </Show>
                      </span>
                    )}
                  </Show>
                  <Show when={editing() && saveStatus() !== "idle"}>
                    <span class="detail-save-status">
                      {saveStatus() === "saving" ? "保存中…" : "保存しました"}
                    </span>
                  </Show>
                </span>

                <div class="detail-actions">
                  <Show
                    when={editing()}
                    fallback={
                      <button
                        type="button"
                        class="icon-button"
                        title="編集"
                        aria-label="編集"
                        onClick={startEditing}
                      >
                        <Icon name="pencil" size={17} />
                      </button>
                    }
                  >
                    <button
                      type="button"
                      class="icon-button"
                      title="編集を終える"
                      aria-label="編集を終える"
                      onClick={() => void stopEditing()}
                    >
                      <Icon name="check" size={17} />
                    </button>
                  </Show>
                  <Show when={item().kind === "timeline"}>
                    <button
                      type="button"
                      class="icon-button"
                      title="ノートに昇格"
                      aria-label="ノートに昇格"
                      onClick={() => promote(item() as TimelineItem)}
                    >
                      <Icon name="note-pencil" size={17} />
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="icon-button"
                    title="削除"
                    aria-label="削除"
                    onClick={() => remove(item())}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </div>
              </div>

              <div class="detail-body">
                <Show
                  when={editing()}
                  fallback={
                    <Show
                      when={item().kind === "note"}
                      fallback={<p class="detail-plain">{(item() as TimelineItem).text}</p>}
                    >
                      <MarkdownPreview source={noteBody()} />
                    </Show>
                  }
                >
                  <Show
                    when={item().kind === "note"}
                    fallback={
                      <textarea
                        class="detail-editor"
                        value={draft()}
                        onInput={(e) => {
                          setDraft(e.currentTarget.value);
                          scheduleSave();
                        }}
                      />
                    }
                  >
                    <MilkdownEditor
                      placeholder="ノートを書く…"
                      defaultValue={draft()}
                      onChange={(markdown) => {
                        setDraft(markdown);
                        scheduleSave();
                      }}
                    />
                  </Show>
                </Show>

                <Show when={item().kind === "note"}>
                  <TagChips
                    tags={(item() as NoteItem).tags}
                    onChange={(tags) => updateTags(item() as NoteItem, tags)}
                  />
                </Show>
              </div>
            </>
          )}
        </Show>

        <CaptureBar onSend={capture} />
      </div>
    </div>
  );
}
