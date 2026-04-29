import {
  createSignal,
  createEffect,
  createResource,
  on,
  onCleanup,
  For,
  Show,
  Switch,
  Match,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import MilkdownEditor from "../components/MilkdownEditor";
import MarkdownPreview from "../components/MarkdownPreview";
import ConfirmDialog from "../components/ConfirmDialog";
import ActionBar from "../components/ActionBar";
import Icon from "../components/Icon";

interface Note {
  path: string;
  filename: string;
  time?: string;
  tags: string[];
  preview: string;
}

type ViewMode = "editor" | "list" | "preview";

async function fetchNotes(): Promise<Note[]> {
  return invoke<Note[]>("list_notes");
}

export default function Notes() {
  const [body, setBody] = createSignal("");
  const [tagsInput, setTagsInput] = createSignal("");
  const [draftPath, setDraftPath] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  const [viewMode, setViewMode] = createSignal<ViewMode>("editor");
  const [selectedNote, setSelectedNote] = createSignal<Note | null>(null);
  const [noteContent, setNoteContent] = createSignal("");
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [error, setError] = createSignal("");
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

  const openPreview = async (note: Note) => {
    try {
      setError("");
      const content = await invoke<string>("read_note", { filename: note.filename });
      setSelectedNote(note);
      setNoteContent(content);
      setViewMode("preview");
    } catch (e) {
      setError(String(e));
    }
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
    try {
      await invoke("delete_note", { filename: note.filename });
      setSelectedNote(null);
      setNoteContent("");
      refetchNotes();
      setViewMode("list");
    } catch (e) {
      setError(String(e));
    }
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
            <button type="button" onClick={openList} aria-label="ノート一覧を開く">
              <Icon name="list" size={16} />
            </button>
          </ActionBar>
        </Match>

        <Match when={viewMode() === "list"}>
          <div class="notes-list-container">
            <Show when={error()}>
              <p class="error-text">{error()}</p>
            </Show>
            <div class="browse-list">
              <Show when={notes()?.length} fallback={<p class="empty-state">ノートなし</p>}>
                <For each={notes()}>
                  {(note) => (
                    <button
                      class="browse-list-item note-list-item"
                      onClick={() => openPreview(note)}
                    >
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
            <button type="button" onClick={openEditor} aria-label="新規ノート">
              <Icon name="plus" size={16} />
            </button>
          </ActionBar>
        </Match>

        <Match when={viewMode() === "preview"}>
          <div class="note-preview-container">
            <Show when={error()}>
              <p class="error-text">{error()}</p>
            </Show>
            <MarkdownPreview source={noteContent()} />
          </div>

          <ActionBar>
            <button type="button" onClick={goBack} aria-label="戻る">
              <Icon name="arrow-left" size={16} />
            </button>
            <button type="button" onClick={editNote} aria-label="ノートを編集">
              <Icon name="pencil" size={16} />
            </button>
            <button type="button" onClick={confirmDelete} aria-label="ノートを削除">
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
