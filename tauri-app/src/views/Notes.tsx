import { createSignal, createEffect, on, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import MilkdownEditor from "../components/MilkdownEditor";
import ActionBar from "../components/ActionBar";
import Icon from "../components/Icon";

export default function Notes() {
  const [body, setBody] = createSignal("");
  const [tagsInput, setTagsInput] = createSignal("");
  const [draftPath, setDraftPath] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved">("idle");

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const parseTags = () =>
    tagsInput()
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

  const save = async () => {
    const currentBody = body();
    if (!currentBody.trim()) return;

    const tags = parseTags();
    setStatus("saving");

    try {
      const path = draftPath();
      if (path) {
        await invoke("update_draft", {
          filePath: path,
          body: currentBody,
          tags,
        });
      } else {
        const newPath = await invoke<string>("create_draft", {
          body: currentBody,
          tags,
        });
        setDraftPath(newPath);
      }
      setStatus("saved");
    } catch {
      setStatus("idle");
    }
  };

  const scheduleSave = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(save, 1000);
  };

  createEffect(
    on(body, () => {
      if (body().trim()) scheduleSave();
    }),
  );

  createEffect(
    on(tagsInput, () => {
      if (draftPath() && tagsInput()) scheduleSave();
    }),
  );

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  const handleDone = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    setBody("");
    setTagsInput("");
    setDraftPath(null);
    setStatus("idle");
  };

  return (
    <div class="view view--flush">
      <div class="notes-editor">
        <MilkdownEditor placeholder="Write your note in Markdown..." onChange={setBody} />
      </div>

      <Show when={status() !== "idle"}>
        <span class="status-indicator">
          {status() === "saving" && "Saving..."}
          {status() === "saved" && "Saved"}
        </span>
      </Show>

      <ActionBar>
        <input
          type="text"
          class="tags-input"
          placeholder="Tags (comma separated)"
          value={tagsInput()}
          onInput={(e) => setTagsInput(e.currentTarget.value)}
        />
        <button type="button" onClick={handleDone} disabled={!draftPath()}>
          <Icon name="check-square" size={16} />
          Done
        </button>
      </ActionBar>
    </div>
  );
}
