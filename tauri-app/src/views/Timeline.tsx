import { createSignal, createResource, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import ActionBar from "../components/ActionBar";
import Icon from "../components/Icon";

async function fetchEntries(): Promise<string[]> {
  return invoke<string[]>("read_timeline");
}

export default function Timeline() {
  const [text, setText] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [entries, { refetch }] = createResource(fetchEntries);

  const handleSend = async () => {
    const trimmed = text().trim();
    if (!trimmed) return;

    setSaving(true);
    try {
      await invoke("save_quick_capture", { text: trimmed });
      setText("");
      refetch();
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

  return (
    <div class="view">
      <div class="timeline">
        <textarea
          class="memo-input"
          rows={2}
          placeholder="What's on your mind?"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />

        <Show when={entries()?.length}>
          <div class="timeline-entries">
            <For each={entries()!.slice().reverse()}>
              {(entry) => (
                <div class="timeline-entry">{entry}</div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <ActionBar>
        <button
          type="button"
          onClick={handleSend}
          disabled={saving() || !text().trim()}
        >
          <Icon name="paper-plane-tilt" size={16} />
          Send
        </button>
      </ActionBar>
    </div>
  );
}
