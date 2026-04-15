import { createSignal, createEffect, createResource, on, onCleanup, For, Show, Switch, Match } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import MilkdownEditor from "../components/MilkdownEditor";
import MarkdownPreview from "../components/MarkdownPreview";
import ConfirmDialog from "../components/ConfirmDialog";
import ActionBar from "../components/ActionBar";
import Icon from "../components/Icon";

interface NoteSummary {
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
}

type ViewMode = "editor" | "list" | "preview";

async function fetchNotes(): Promise<NoteSummary[]> {
  return invoke<NoteSummary[]>("list_notes");
}

export default function Notes() {
  const [body, setBody] = createSignal("");
  const [tagsInput, setTagsInput] = createSignal("");
  const [draftPath, setDraftPath] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  const [viewMode, setViewMode] = createSignal<ViewMode>("editor");
  const [selectedNote, setSelectedNote] = createSignal<NoteSummary | null>(null);
  const [noteContent, setNoteContent] = createSignal("");
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [notes, { refetch: refetchNotes }] = createResource(fetchNotes);

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
      if (draftPath()) scheduleSave();
    }),
  );

  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  const handleDone = async () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (draftPath() && body().trim()) {
      await save();
    }
    resetEditor();
  };

  const resetEditor = () => {
    setBody("");
    setTagsInput("");
    setDraftPath(null);
    setStatus("idle");
  };

  const openList = () => {
    refetchNotes();
    setViewMode("list");
  };

  const openPreview = async (note: NoteSummary) => {
    setSelectedNote(note);
    const content = await invoke<string>("read_note", { filePath: note.path });
    setNoteContent(content);
    setViewMode("preview");
  };

  const openEditor = () => {
    resetEditor();
    setViewMode("editor");
  };

  const editNote = () => {
    const note = selectedNote();
    if (!note) return;
    const content = noteContent();
    const bodyText = extractBody(content);
    setDraftPath(note.path);
    setBody(bodyText);
    setTagsInput(note.tags.join(", "));
    setViewMode("editor");
  };

  const confirmDelete = () => {
    setConfirmOpen(true);
  };

  const handleDelete = async () => {
    const note = selectedNote();
    if (!note) return;
    setConfirmOpen(false);
    await invoke("delete_note", { filePath: note.path });
    setSelectedNote(null);
    setNoteContent("");
    refetchNotes();
    setViewMode("list");
  };

  const goBack = () => {
    if (viewMode() === "preview") {
      setSelectedNote(null);
      setNoteContent("");
      setViewMode("list");
    } else {
      setViewMode("editor");
    }
  };

  const formatTime = (time?: string) => {
    if (!time) return "";
    const d = new Date(time);
    return d.toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div class="view view--flush">
      <Switch>
        <Match when={viewMode() === "editor"}>
          <div class="notes-editor">
            <MilkdownEditor
              placeholder="Write your note in Markdown..."
              defaultValue={body()}
              onChange={setBody}
            />
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
            <button type="button" onClick={openList}>
              <Icon name="list" size={16} />
            </button>
          </ActionBar>
        </Match>

        <Match when={viewMode() === "list"}>
          <div class="notes-list-container">
            <div class="browse-list">
              <Show when={notes()?.length} fallback={<p class="empty-state">ノートなし</p>}>
                <For each={notes()}>
                  {(note) => (
                    <button class="browse-list-item note-list-item" onClick={() => openPreview(note)}>
                      <span class="note-preview-text">{note.preview || "(empty)"}</span>
                      <span class="note-meta">
                        <Show when={note.time}>
                          <span class="note-time">{formatTime(note.time)}</span>
                        </Show>
                        <Show when={note.tags.length}>
                          <span class="note-tags">{note.tags.join(", ")}</span>
                        </Show>
                      </span>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>

          <ActionBar>
            <button type="button" onClick={openEditor}>
              <Icon name="plus" size={16} />
            </button>
          </ActionBar>
        </Match>

        <Match when={viewMode() === "preview"}>
          <div class="note-preview-container">
            <MarkdownPreview source={noteContent()} />
          </div>

          <ActionBar>
            <button type="button" onClick={goBack}>
              <Icon name="arrow-left" size={16} />
            </button>
            <button type="button" onClick={editNote}>
              <Icon name="pencil" size={16} />
            </button>
            <button type="button" onClick={confirmDelete}>
              <Icon name="trash" size={16} />
            </button>
          </ActionBar>

          <ConfirmDialog
            open={confirmOpen()}
            title="メモを削除しますか？"
            message="この操作は元に戻せません。"
            onConfirm={handleDelete}
            onCancel={() => setConfirmOpen(false)}
          />
        </Match>
      </Switch>
    </div>
  );
}

function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}
