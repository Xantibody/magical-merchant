import { batch, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Icon from "../components/Icon";
import Popover from "../components/Popover";
import { typedInvoke } from "../lib/commands";
import type { Template, TemplateDetail } from "../lib/commands";
import { useShell } from "../lib/shell";
import { locale, t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { createKeyboardTop, keyboardTopStyle } from "../lib/keyboard";
import { joinTitle, splitTitle } from "../lib/note-title";
import { MODE_LABELS, ROUTES } from "../lib/routes";
import {
  addTemplateTag,
  hasVariable,
  resolveBody,
  resolveLine,
  splitVariables,
  TEMPLATE_VARS,
} from "../lib/template-vars";
import "../styles/templates.css";

const UNDO_MS = 5000;

/** How long "saved" stays. Green is for the moment right after a save, not a state. */
const SAVED_FLASH_MS = 2000;

/** Where a variable chip is inserted. These three fields are the ones that take `{{...}}`. */
type VarField = "title" | "body" | "tag";

/** The one template being edited. Compared with the template file to show "unsaved". */
interface Draft {
  title: string;
  body: string;
  tags: string[];
}

const EMPTY_DRAFT: Draft = { title: "", body: "", tags: [] };

/**
 * Drop characters a filename cannot hold. A template's name becomes its filename as is.
 *
 * This is here to fix a typo, not as the last line of defence. Separators, `..` and NUL are
 * all rejected again by core's `NoteFilename` once it receives them.
 */
function toFileStem(raw: string): string {
  return raw.trim().replaceAll(/[/\\:*?"<>|]/gu, "");
}

/** The editable shape of a template file: the title line is its own field. */
function toDraft(detail: TemplateDetail): Draft {
  const titled = splitTitle(detail.body);
  return { title: titled.title, body: titled.body, tags: detail.tags };
}

/** A row as the list draws it. */
function toRow(template: Template, saved: boolean, draft: boolean): Row {
  return {
    filename: template.filename,
    name: template.name,
    tags: template.tags,
    preview: template.preview,
    saved,
    draft,
  };
}

/** A row of the list: a saved template, or a new one that so far exists only as a draft. */
interface Row extends Template {
  /** Whether the template file exists. A row that is only a draft has never been saved. */
  saved: boolean;
  /** Whether there is an edit not yet saved into the template. */
  draft: boolean;
}

/** How long typing pauses before the draft is written. Leaving the screen writes it at once. */
const DRAFT_DELAY_MS = 300;

/**
 * The template management screen.
 *
 * It is built as the same two panes as Workspace; only what is written changes, from a
 * "note" to a "note template". The editor (Milkdown) is not used for editing because what
 * matters here is not how the body looks but where the `{{...}}` are.
 */
export default function Templates(): JSX.Element {
  const shell = useShell();
  const navigate = useNavigate();

  const [templates, { refetch }] = createResource(() => typedInvoke("list_templates"));
  const [drafts, { refetch: refetchDrafts }] = createResource(() =>
    typedInvoke("list_template_drafts"),
  );
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  /** Holds a draft name only while creating a new one. null while editing an existing one. */
  const [draftName, setDraftName] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagInput, setTagInput] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  /** The last state read from the template file or written to it. */
  const [baseline, setBaseline] = createSignal<Draft>(EMPTY_DRAFT);
  /** Hidden from the list only during the delete grace period. */
  const [hidden, setHidden] = createSignal<string[]>([]);
  /** The notes on disk, read once, to say how many came from each template. */
  const [notes] = createResource(() => typedInvoke("list_notes"));
  /** A save just went through. Cleared after SAVED_FLASH_MS. */
  const [savedFlash, setSavedFlash] = createSignal(false);
  /** Save was pressed on a new template with no name. */
  const [nameError, setNameError] = createSignal(false);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal("");
  const [renameError, setRenameError] = createSignal<string | undefined>();

  let bodyRef: HTMLTextAreaElement | undefined;
  let titleRef: HTMLInputElement | undefined;
  let tagRef: HTMLInputElement | undefined;
  let nameRef: HTMLInputElement | undefined;
  let highlightRef: HTMLPreElement | undefined;
  let moreRef: HTMLButtonElement | undefined;
  let renameRef: HTMLInputElement | undefined;

  /** Notes made from each template, by template name (`template:` in their frontmatter). */
  const noteCounts = createMemo<ReadonlyMap<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const note of notes() ?? []) {
      if (note.template) {
        counts.set(note.template, (counts.get(note.template) ?? 0) + 1);
      }
    }
    return counts;
  });
  const noteCount = (name: string): number => noteCounts().get(name) ?? 0;

  /** The field touched last. If a chip is pressed right after opening, it goes in the body. */
  const [varField, setVarField] = createSignal<VarField>("body");

  const fieldInput = (field: VarField): HTMLInputElement | HTMLTextAreaElement | undefined => {
    if (field === "title") {
      return titleRef;
    }
    if (field === "tag") {
      return tagRef;
    }
    return bodyRef;
  };

  // The variable row sits at the bottom edge of the screen. On a touch device the keyboard
  // covers exactly that spot, so move the row above it only while the keyboard is open
  const keyboardTop = createKeyboardTop();

  /** Saved templates and never-saved drafts, one list by name. */
  const rows = createMemo<Row[]>(() => {
    const dropped = new Set(hidden());
    const drafted = new Map((drafts() ?? []).map((draft) => [draft.filename, draft]));
    const saved: Row[] = (templates() ?? []).map((template) =>
      toRow(template, true, drafted.has(template.filename)),
    );
    const savedFiles = new Set(saved.map((row) => row.filename));
    const fresh: Row[] = [...drafted.values()]
      .filter((draft) => !savedFiles.has(draft.filename))
      .map((draft) => toRow(draft, false, true));
    return [...saved, ...fresh]
      .filter((row) => !dropped.has(row.filename))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  });

  const selected = createMemo<Row | undefined>(() =>
    rows().find((row) => row.saved && row.filename === selectedFile()),
  );

  /**
   * The filename a new template's draft is written under right now. Its name can still
   * change, and the draft moves with it.
   */
  let newDraftFile: string | undefined;

  /** Whether the name typed while creating a new one collides with another template. */
  const nameTaken = createMemo<boolean>(() => {
    const draft = toFileStem(draftName() ?? "");
    return (
      draft !== "" &&
      // Its own draft is in the list too; it is not a collision with itself
      rows().some((row) => row.name === draft && row.filename !== newDraftFile)
    );
  });

  const editing = (): boolean => selected() !== undefined || draftName() !== null;

  /** Copy in the state to edit, against the saved template it is compared with. */
  const load = (saved: Draft, shown: Draft = saved): void => {
    batch(() => {
      setTitle(shown.title);
      setBody(shown.body);
      setTags(shown.tags);
      setBaseline(saved);
      setSaveStatus("idle");
    });
  };

  const current = (): Draft => ({ title: title(), body: body(), tags: tags() });

  /** Read a saved template, and its draft over it if there is one. */
  const openSaved = async (file: string): Promise<void> => {
    try {
      const [detail, draft] = await Promise.all([
        typedInvoke("read_template", { filename: file }),
        typedInvoke("read_template_draft", { filename: file }),
      ]);
      if (selectedFile() !== file || draftName() !== null) {
        return;
      }
      const saved = toDraft(detail);
      load(saved, draft ? toDraft(draft) : saved);
    } catch {
      if (selectedFile() === file) {
        load(EMPTY_DRAFT);
      }
    }
  };

  /** Whether it differs from the template file. This decides if the save button is enabled. */
  const dirty = createMemo<boolean>(() => {
    const base = baseline();
    return (
      title() !== base.title ||
      body() !== base.body ||
      tags().length !== base.tags.length ||
      tags().some((tag, at) => tag !== base.tags[at])
    );
  });

  /** Where what is being written is saved. Nothing is saved until the name is settled. */
  const targetFilename = (): string | undefined => {
    const draft = draftName();
    if (draft !== null) {
      const stem = toFileStem(draft);
      // The name is empty, or it already exists. Either one would overwrite by accident
      return stem === "" || nameTaken() ? undefined : `${stem}.md`;
    }
    return selected()?.filename;
  };

  /**
   * Whether there is anything to save. A new one can be written as soon as the name is
   * settled: an empty template is still meaningful. An existing one only when it changed.
   */
  const canSave = (): boolean =>
    targetFilename() !== undefined &&
    saveStatus() !== "saving" &&
    (draftName() !== null || dirty());

  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flashTimer));

  /**
   * Write the edit in progress to the template's draft. The template file itself is not
   * touched: every note made from it copies it, so it changes only on save.
   */
  const writeDraft = (): void => {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    const filename = targetFilename();
    const previous = draftName() === null ? undefined : newDraftFile;
    if (draftName() !== null) {
      newDraftFile = filename;
    }
    const draft = current();
    void (async () => {
      try {
        // A new template's name changed: the draft follows it rather than staying behind
        if (previous && previous !== filename) {
          await typedInvoke("discard_template_draft", { filename: previous });
        }
        if (filename) {
          await typedInvoke("save_template_draft", {
            filename,
            body: joinTitle(draft.title, draft.body),
            tags: draft.tags,
          });
        }
        await refetchDrafts();
      } catch {
        shell.showToast(t().templates.saveFailed);
      }
    })();
  };

  /** Called by every edit. The draft is written once typing pauses. */
  const edited = (): void => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, DRAFT_DELAY_MS);
  };

  /** Write a pending draft now: the screen is about to change. */
  const flushDraft = (): void => {
    if (draftTimer !== undefined) {
      writeDraft();
    }
  };
  onCleanup(flushDraft);

  /**
   * Save explicitly. A template left half-written breaks every note made from it, so this
   * is not built to write out on each keystroke; the draft is what keeps the keystrokes.
   */
  const save = (): void => {
    const filename = targetFilename();
    if (!filename || !canSave()) {
      return;
    }
    clearTimeout(draftTimer);
    draftTimer = undefined;
    const draft = current();
    const previous = newDraftFile;
    setSaveStatus("saving");

    void (async () => {
      try {
        await typedInvoke("save_template", {
          filename,
          body: joinTitle(draft.title, draft.body),
          tags: draft.tags,
        });
        if (previous && previous !== filename) {
          await typedInvoke("discard_template_draft", { filename: previous });
        }
        batch(() => {
          setBaseline(draft);
          setSaveStatus("idle");
          setSavedFlash(true);
        });
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => setSavedFlash(false), SAVED_FLASH_MS);
        await Promise.all([refetch(), refetchDrafts()]);
        // Once the name is settled, this turns from creating a new one into editing it
        if (draftName() !== null) {
          newDraftFile = undefined;
          batch(() => {
            setDraftName(null);
            setSelectedFile(filename);
          });
        }
      } catch {
        setSaveStatus("idle");
        shell.showToast(t().templates.saveFailed);
      }
    })();
  };

  /**
   * The save button stays pressable for a new template without a name. Disabled, it would
   * not say why; pressed, it takes the user to the name and says what it is for.
   */
  const canPressSave = (): boolean =>
    saveStatus() !== "saving" && (draftName() !== null || dirty());

  const pressSave = (): void => {
    if (draftName() !== null && toFileStem(draftName() ?? "") === "") {
      setNameError(true);
      nameRef?.focus();
      return;
    }
    if (nameTaken()) {
      nameRef?.focus();
      return;
    }
    save();
  };

  const openRename = (): void => {
    batch(() => {
      setRenameValue(selected()?.name ?? "");
      setRenameError(undefined);
      setRenaming(true);
    });
    queueMicrotask(() => renameRef?.select());
  };

  /**
   * Rename the template file. The notes made from it keep the old name, which the panel
   * says before this runs.
   */
  const confirmRename = (): void => {
    const from = selected();
    if (!from) {
      return;
    }
    const stem = toFileStem(renameValue());
    if (stem === "") {
      setRenameError(t().templates.nameEmpty);
      return;
    }
    if (stem === from.name) {
      setRenaming(false);
      return;
    }
    if (rows().some((row) => row.name === stem)) {
      setRenameError(t().templates.nameTaken);
      return;
    }
    const to = `${stem}.md`;
    // The draft moves with the template in core; one still waiting is written after
    const pending = draftTimer !== undefined;
    clearTimeout(draftTimer);
    draftTimer = undefined;

    void (async () => {
      try {
        await typedInvoke("rename_template", { from: from.filename, to });
        await Promise.all([refetch(), refetchDrafts()]);
        batch(() => {
          setSelectedFile(to);
          setRenaming(false);
        });
        if (pending) {
          writeDraft();
        }
        shell.showToast(t().templates.renamed(stem));
      } catch {
        setRenameError(t().templates.renameFailed);
      }
    })();
  };

  // Cmd+S / Ctrl+S. With the save button as the only way in, nothing can be kept while
  // writing. With Shift it is the app-wide "sync now", so it is not picked up here
  const onKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (canPressSave()) {
        pressSave();
      }
    } else if (e.key === "Escape" && menuOpen()) {
      // The menu is this screen's own popover; AppLayout's Escape knows only the shell's
      setMenuOpen(false);
    }
  };
  globalThis.addEventListener("keydown", onKeyDown);
  onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

  /**
   * Leave the editor. The draft carries whatever was unsaved, so there is nothing to
   * discard. The one exception is a new template with no name yet: there is no filename to
   * keep its draft under, so it is dropped with a way back.
   */
  const leaveEditor = (next: () => void): void => {
    flushDraft();
    batch(() => {
      setRenaming(false);
      setMenuOpen(false);
      setNameError(false);
      setSavedFlash(false);
    });
    const unnamed = draftName() !== null && targetFilename() === undefined;
    const draft = current();
    const blank = draft.title === "" && draft.body === "" && draft.tags.length === 0;
    if (unnamed && !blank) {
      const name = draftName();
      shell.showToast(t().templates.discarded, () => {
        newDraftFile = undefined;
        batch(() => {
          setSelectedFile(null);
          setDraftName(name);
          load(EMPTY_DRAFT, draft);
          setDetailOpen(true);
        });
      });
    }
    newDraftFile = undefined;
    next();
  };

  const startNew = (): void => {
    leaveEditor(() => {
      batch(() => {
        setSelectedFile(null);
        setDraftName("");
        setTagInput("");
        setDetailOpen(true);
        load(EMPTY_DRAFT);
      });
      // Nothing can be saved until the name is settled, so go to what is needed first
      queueMicrotask(() => nameRef?.focus());
    });
  };

  const select = (row: Row): void => {
    leaveEditor(() => {
      if (row.saved) {
        batch(() => {
          setDraftName(null);
          setSelectedFile(row.filename);
          setDetailOpen(true);
        });
        void openSaved(row.filename);
        return;
      }
      // A template never saved: it is still being created, under the name it was left with
      newDraftFile = row.filename;
      batch(() => {
        setSelectedFile(null);
        setDraftName(row.name);
        setTagInput("");
        setDetailOpen(true);
        load(EMPTY_DRAFT);
      });
      void (async () => {
        const draft = await typedInvoke("read_template_draft", { filename: row.filename });
        if (draft && newDraftFile === row.filename) {
          load(EMPTY_DRAFT, toDraft(draft));
        }
      })();
    });
  };

  /** Drop the unsaved edit and go back to the saved template, with a way back. */
  const discardDraft = (): void => {
    const filename = selected()?.filename;
    if (!filename) {
      return;
    }
    clearTimeout(draftTimer);
    draftTimer = undefined;
    const dropped = current();
    load(baseline());
    void (async () => {
      await typedInvoke("discard_template_draft", { filename });
      await refetchDrafts();
    })();

    shell.showToast(t().templates.discarded, () => {
      if (selectedFile() === filename && draftName() === null) {
        load(baseline(), dropped);
      }
      void (async () => {
        await typedInvoke("save_template_draft", {
          filename,
          body: joinTitle(dropped.title, dropped.body),
          tags: dropped.tags,
        });
        await refetchDrafts();
      })();
    });
  };

  const remove = (row: Row): void => {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    newDraftFile = undefined;
    batch(() => {
      setHidden((files) => [...files, row.filename]);
      setSelectedFile(null);
      setDraftName(null);
      setDetailOpen(false);
    });

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_template", { filename: row.filename });
        await Promise.all([refetch(), refetchDrafts()]);
        setHidden((files) => files.filter((file) => file !== row.filename));
      })();
    }, UNDO_MS);

    shell.showToast(t().templates.deleted, () => {
      clearTimeout(commit);
      setHidden((files) => files.filter((file) => file !== row.filename));
    });
  };

  /** The row being edited, whether saved or still a new template's draft. */
  const openRow = (): Row | undefined =>
    selected() ?? rows().find((row) => !row.saved && row.filename === newDraftFile);

  const commitTagInput = (): void => {
    const before = tags();
    setTags((tagList) => addTemplateTag(tagList, tagInput()));
    setTagInput("");
    if (tags() !== before) {
      edited();
    }
  };

  /**
   * Insert a variable where the cursor is. The target is the field touched last: were it
   * always the body, there would be no way to put a variable in the title or a tag. Focus
   * returns to that field after the press.
   */
  const insertVariable = (token: string): void => {
    const field = varField();
    const el = fieldInput(field);
    if (!el) {
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = `${el.value.slice(0, start)}${token}${el.value.slice(end)}`;

    if (field === "title") {
      setTitle(next);
      edited();
    } else if (field === "tag") {
      setTagInput(next);
    } else {
      setBody(next);
      edited();
    }

    const caret = start + token.length;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  /** "This is what it makes today". Whether a variable is written right shows up here. */
  const preview = createMemo<{ title: string; tags: string[]; body: string }>(() => {
    const now = new Date();
    return {
      title: resolveLine(title(), now, locale()),
      tags: tags()
        .map((tag) => resolveLine(tag, now, locale()))
        .filter((tag) => tag.trim() !== ""),
      body: resolveBody(body(), now, locale()),
    };
  });

  return (
    <div class="workspace templates" classList={{ "workspace--detail": detailOpen() }}>
      <div class="list-pane">
        <div class="list-pane-head">
          <button
            type="button"
            class="icon-button templates-back"
            aria-label={t().templates.backToSettings}
            onClick={() => navigate(ROUTES.SETTINGS)}
          >
            <Icon name="arrow-left" size={16} />
          </button>
          <span class="list-pane-title">{MODE_LABELS[ROUTES.TEMPLATES]}</span>
          <button type="button" class="new-note" onClick={startNew}>
            <Icon name="plus" size={12} />
            {t().templates.new}
          </button>
        </div>

        <div class="list-scroll">
          <Show
            when={rows().length > 0}
            fallback={
              <div class="notes-empty">
                <Icon name="file-text" size={24} />
                <p class="notes-empty-title">{t().templates.empty}</p>
                <p class="notes-empty-body">{t().templates.emptyHint}</p>
              </div>
            }
          >
            <For each={rows()}>
              {(row) => {
                const open = (): boolean => openRow()?.filename === row.filename;
                // The open row follows the typing; the others what core last reported
                const unsaved = (): boolean => (open() ? dirty() || !row.saved : row.draft);
                return (
                  <button
                    type="button"
                    class="list-row"
                    classList={{ "list-row--selected": open() }}
                    onClick={() => select(row)}
                  >
                    <span class="templates-row-head">
                      <span class="list-row-title">{row.name}</span>
                      <Show when={unsaved()}>
                        <span class="templates-row-unsaved">{t().templates.unsaved}</span>
                      </Show>
                    </span>
                    {/* Resolved: the row answers "what does this make today". How the
                        definition is spelled, `{{date}}` and all, is read once it is open.
                        A template never saved makes nothing yet */}
                    <span class="list-row-meta">
                      {row.saved
                        ? [
                            resolveLine(row.preview, new Date(), locale()),
                            noteCount(row.name) > 0
                              ? t().templates.noteCount(noteCount(row.name))
                              : "",
                          ]
                            .filter((part) => part !== "")
                            .join(" · ")
                        : t().templates.new}
                    </span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>

        <p class="templates-file-hint">{t().templates.fileHint}</p>
      </div>

      <div class="detail-pane">
        <Show
          when={editing()}
          fallback={<div class="detail-empty">{t().templates.noSelection}</div>}
        >
          <div class="detail-meta-bar">
            <button
              type="button"
              class="icon-button detail-back"
              aria-label={t().templates.backToList}
              onClick={() => leaveEditor(() => setDetailOpen(false))}
            >
              <Icon name="arrow-left" size={18} />
            </button>
            <div class="templates-name-block">
              <Show
                when={draftName() === null}
                fallback={
                  <>
                    <label class="templates-label" for="templates-name-input">
                      {t().templates.nameLabel}
                    </label>
                    <input
                      id="templates-name-input"
                      type="text"
                      class="templates-name-input"
                      classList={{ "templates-name-input--error": nameError() || nameTaken() }}
                      ref={nameRef}
                      placeholder={t().templates.namePlaceholder}
                      value={draftName() ?? ""}
                      onInput={(e) => {
                        setDraftName(e.currentTarget.value);
                        setNameError(false);
                        edited();
                      }}
                    />
                  </>
                }
              >
                <span class="templates-label">{t().templates.nameLabel}</span>
                {/* The name is the value written into a note's frontmatter, so changing it
                    goes through a panel that says how many notes lose their link first */}
                <span class="templates-name-row">
                  <span class="templates-name">{selected()?.name}</span>
                  <button type="button" class="templates-rename-button" onClick={openRename}>
                    {t().templates.rename}
                  </button>
                </span>
              </Show>
            </div>
            {/* Green only for the moment right after a save (workspace.css); unsaved is
                said for as long as it is true; otherwise nothing is left to say */}
            <Show
              when={savedFlash() && !dirty() && draftName() === null}
              fallback={
                <Show when={dirty() || draftName() !== null}>
                  <span class="detail-save-status templates-unsaved">{t().templates.unsaved}</span>
                </Show>
              }
            >
              <span class="detail-save-status templates-saved">{t().common.saved}</span>
            </Show>

            <div class="detail-actions">
              <button
                type="button"
                class="button-primary templates-save"
                disabled={!canPressSave()}
                onClick={pressSave}
              >
                {t().common.save}
              </button>
              <Show when={openRow()}>
                {(row) => (
                  <div class="templates-more">
                    <button
                      type="button"
                      class="icon-button templates-more-button"
                      ref={moreRef}
                      title={t().templates.more}
                      aria-label={t().templates.more}
                      aria-expanded={menuOpen()}
                      onClick={() => setMenuOpen(!menuOpen())}
                    >
                      <Icon name="dots-three" size={18} />
                    </button>
                    <Popover
                      open={menuOpen()}
                      onClose={() => setMenuOpen(false)}
                      trigger={() => moreRef}
                      label={t().templates.more}
                    >
                      <div class="popover templates-menu" role="menu">
                        <Show when={selected() !== undefined && dirty()}>
                          <button
                            type="button"
                            role="menuitem"
                            class="templates-menu-item"
                            onClick={() => {
                              setMenuOpen(false);
                              discardDraft();
                            }}
                          >
                            {t().templates.discardDraft}
                          </button>
                          <hr class="templates-menu-divider" />
                        </Show>
                        <button
                          type="button"
                          role="menuitem"
                          class="templates-menu-item templates-menu-item--danger"
                          onClick={() => {
                            setMenuOpen(false);
                            remove(row());
                          }}
                        >
                          {t().common.delete}
                        </button>
                      </div>
                    </Popover>
                  </div>
                )}
              </Show>
            </div>
          </div>

          <Show when={renaming()}>
            <div class="templates-rename">
              <label class="templates-label" for="templates-rename-input">
                {t().templates.renameNew}
              </label>
              <input
                id="templates-rename-input"
                type="text"
                class="first-run-input templates-rename-input"
                classList={{ "templates-rename-input--error": renameError() !== undefined }}
                ref={renameRef}
                value={renameValue()}
                onInput={(e) => {
                  setRenameValue(e.currentTarget.value);
                  setRenameError(undefined);
                }}
                onKeyDown={(e) => {
                  // The Enter that commits a conversion belongs to the IME (#102)
                  if (e.key === "Enter" && !isImeComposing(e)) {
                    e.preventDefault();
                    confirmRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenaming(false);
                  }
                }}
              />
              <p class="templates-rename-note">
                {noteCount(selected()?.name ?? "") > 0
                  ? t().templates.renameWarn(noteCount(selected()?.name ?? ""))
                  : t().templates.renameNone}
              </p>
              <Show when={renameError()}>
                {(error) => <p class="templates-name-error">{error()}</p>}
              </Show>
              <div class="templates-rename-actions">
                <button type="button" class="button-secondary" onClick={() => setRenaming(false)}>
                  {t().common.cancel}
                </button>
                <button type="button" class="button-primary" onClick={confirmRename}>
                  {t().templates.rename}
                </button>
              </div>
            </div>
          </Show>

          <Show when={nameTaken() || nameError()}>
            <p class="templates-name-error">
              {nameTaken() ? t().templates.nameTaken : t().templates.nameRequired}
            </p>
          </Show>

          <div class="templates-field templates-title-field">
            <label class="templates-label" for="templates-title-input">
              {t().templates.titleLabel}
            </label>
            <input
              id="templates-title-input"
              type="text"
              class="note-title-input"
              ref={titleRef}
              placeholder={t().templates.titlePlaceholder}
              value={title()}
              onFocus={() => setVarField("title")}
              onInput={(e) => {
                setTitle(e.currentTarget.value);
                edited();
              }}
            />
          </div>

          <div class="templates-tags">
            <span class="templates-tags-label">{t().templates.autoTags}</span>
            <For each={tags()}>
              {(tag) => (
                <span class="tag-badge" classList={{ "tag-badge--var": hasVariable(tag) }}>
                  #{tag}
                  <button
                    type="button"
                    class="note-meta-tag-remove"
                    aria-label={t().templates.removeTag(tag)}
                    onClick={() => {
                      setTags((tagList) => tagList.filter((kept) => kept !== tag));
                      edited();
                    }}
                  >
                    <Icon name="x" size={10} />
                  </button>
                </span>
              )}
            </For>
            <input
              type="text"
              class="templates-tag-input"
              ref={tagRef}
              placeholder={t().templates.addTag}
              aria-label={t().templates.addTag}
              value={tagInput()}
              onFocus={() => setVarField("tag")}
              onInput={(e) => setTagInput(e.currentTarget.value)}
              onBlur={commitTagInput}
              onKeyDown={(e) => {
                // The Enter that commits a conversion belongs to the IME (#102)
                if (e.key === "Enter" && !isImeComposing(e)) {
                  e.preventDefault();
                  commitTagInput();
                }
              }}
            />
          </div>

          {/* The body. The textarea holds the text as written, and the colour of `{{...}}`
              is drawn by a layer of the same text laid directly under it. A textarea cannot
              colour part of itself, so stacking is the only way to show it */}
          <div class="templates-body-bar">
            <span class="templates-label">{t().templates.bodyLabel}</span>
          </div>

          <div class="templates-body">
            <pre class="templates-body-highlight" aria-hidden="true" ref={highlightRef}>
              <For each={splitVariables(body())}>
                {(run) => <span classList={{ "templates-var": run.variable }}>{run.text}</span>}
              </For>
              {"\n"}
            </pre>
            <textarea
              class="templates-body-input"
              ref={bodyRef}
              placeholder={t().templates.bodyPlaceholder}
              aria-label={t().templates.bodyPlaceholder}
              spellcheck={false}
              value={body()}
              onFocus={() => setVarField("body")}
              onInput={(e) => {
                setBody(e.currentTarget.value);
                edited();
              }}
              onScroll={(e) => {
                if (highlightRef) {
                  highlightRef.scrollTop = e.currentTarget.scrollTop;
                  highlightRef.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
            />
          </div>

          <div
            class="templates-footer"
            classList={{ "templates-footer--floating": keyboardTop() !== undefined }}
            style={keyboardTopStyle(keyboardTop())}
          >
            {/* No heading here. A chip names itself, as in `{{date}}` plus its label, so no
                line of height is spent on something reading the chip already tells you */}
            <div class="templates-vars" role="group" aria-label={t().templates.insertVariable}>
              <For each={TEMPLATE_VARS}>
                {(variable) => (
                  <button
                    type="button"
                    class="tag-chip templates-var-chip"
                    // Do not take the selection from the textarea: the insert point is lost
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertVariable(variable.token)}
                  >
                    <code>{variable.token}</code>
                    {variable.label()}
                  </button>
                )}
              </For>
            </div>
            {/* Folded into one line, the title of "this is what it makes today" is always
                visible. It opens only when the body needs checking too: left open, the
                screen gives more room to reading than to writing */}
            <details class="templates-preview">
              <summary class="templates-preview-summary">
                {t().templates.todayPreview} — {preview().title || t().templates.untitled}
              </summary>
              <div class="templates-preview-body">
                <Show when={preview().tags.length > 0}>
                  <p class="templates-preview-tags">
                    <For each={preview().tags}>
                      {(tag) => <span class="tag-badge">#{tag}</span>}
                    </For>
                  </p>
                </Show>
                {/* A variable left unresolved is marked the same way as in the body layer.
                    What shows up here is either a misspelling or {{prev}}, which is only
                    settled at creation time */}
                <pre class="templates-preview-text">
                  <For each={splitVariables(preview().body)}>
                    {(run) => <span classList={{ "templates-var": run.variable }}>{run.text}</span>}
                  </For>
                </pre>
              </div>
            </details>
          </div>
        </Show>
      </div>
    </div>
  );
}
