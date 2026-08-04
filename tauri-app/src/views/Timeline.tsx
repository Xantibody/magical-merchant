import { createSignal, createResource, For, Show, Switch, Match } from "solid-js";
import { typedInvoke } from "../lib/commands";
import ActionBar from "../components/ActionBar";
import Icon from "../components/Icon";
import TimelineEntry from "../components/TimelineEntry";
import { getLocation } from "../lib/location";

type ViewMode = "input" | "list" | "preview";

async function fetchEntries(): Promise<string[]> {
  return typedInvoke("read_timeline");
}

async function fetchDates(): Promise<string[]> {
  return typedInvoke("list_timeline_dates");
}

async function fetchEntriesByDate(date: string): Promise<string[]> {
  return typedInvoke("read_timeline_by_date", { date });
}

export default function Timeline() {
  const [text, setText] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [sendError, setSendError] = createSignal("");
  const [entries, { refetch }] = createResource(fetchEntries);
  const [viewMode, setViewMode] = createSignal<ViewMode>("input");
  const [selectedDate, setSelectedDate] = createSignal<string | null>(null);
  const [dates, { refetch: refetchDates }] = createResource(fetchDates);
  const [dateEntries] = createResource(selectedDate, (date) =>
    date ? fetchEntriesByDate(date) : Promise.resolve([]),
  );

  const handleSend = async () => {
    const trimmed = text().trim();
    if (!trimmed) return;

    setSaving(true);
    setSendError("");
    try {
      const loc = await getLocation();
      await typedInvoke("save_quick_capture", {
        text: trimmed,
        latitude: loc?.latitude ?? null,
        longitude: loc?.longitude ?? null,
      });
      setText("");
      refetch();
    } catch (e) {
      setSendError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const openList = () => {
    refetchDates();
    setViewMode("list");
  };

  const openPreview = (date: string) => {
    setSelectedDate(date);
    setViewMode("preview");
  };

  const goBack = () => {
    if (viewMode() === "preview") {
      setSelectedDate(null);
      setViewMode("list");
    } else {
      setViewMode("input");
    }
  };

  return (
    <div class="view">
      <Switch>
        <Match when={viewMode() === "input"}>
          <div class="timeline">
            <textarea
              class="memo-input"
              rows={2}
              placeholder="What's on your mind?"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
            />

            <Show when={sendError()}>
              <p class="error-text">{sendError()}</p>
            </Show>

            <Show when={entries()?.length}>
              <div class="timeline-entries">
                <For each={entries()!.slice().reverse()}>
                  {(entry) => <TimelineEntry raw={entry} />}
                </For>
              </div>
            </Show>
          </div>

          <ActionBar>
            <button type="button" onClick={handleSend} disabled={saving() || !text().trim()}>
              <Icon name="paper-plane-tilt" size={16} />
              Send
            </button>
            <button type="button" onClick={openList} aria-label="履歴を開く">
              <Icon name="clock-counter-clockwise" size={16} />
            </button>
          </ActionBar>
        </Match>

        <Match when={viewMode() === "list"}>
          <div class="timeline">
            <div class="browse-list">
              <Show when={dates()?.length} fallback={<p class="empty-state">履歴なし</p>}>
                <For each={dates()}>
                  {(date) => (
                    <button class="browse-list-item" onClick={() => openPreview(date)}>
                      {date}
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>

          <ActionBar>
            <button type="button" onClick={goBack} aria-label="戻る">
              <Icon name="arrow-left" size={16} />
            </button>
          </ActionBar>
        </Match>

        <Match when={viewMode() === "preview"}>
          <div class="timeline">
            <h3 class="preview-date-header">{selectedDate()}</h3>
            <div class="preview-entries">
              <Show when={dateEntries()?.length} fallback={<p class="empty-state">エントリなし</p>}>
                <For each={dateEntries()}>{(entry) => <TimelineEntry raw={entry} markdown />}</For>
              </Show>
            </div>
          </div>

          <ActionBar>
            <button type="button" onClick={goBack} aria-label="戻る">
              <Icon name="arrow-left" size={16} />
            </button>
          </ActionBar>
        </Match>
      </Switch>
    </div>
  );
}
