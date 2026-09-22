import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Icon from "../components/Icon";
import { typedInvoke } from "../lib/commands";
import type { Template } from "../lib/commands";
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

/** Where a variable chip is inserted. These three fields are the ones that take `{{...}}`. */
type VarField = "title" | "body" | "tag";

/** The one template being edited. Compared with what is on disk to show "unsaved". */
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
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [detailOpen, setDetailOpen] = createSignal(false);
  /** Holds a draft name only while creating a new one. null while editing an existing one. */
  const [draftName, setDraftName] = createSignal<string | null>(null);
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [tagInput, setTagInput] = createSignal("");
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle");
  /** The last state read from disk or written to disk. */
  const [baseline, setBaseline] = createSignal<Draft>(EMPTY_DRAFT);
  /** Hidden from the list only during the delete grace period. */
  const [hidden, setHidden] = createSignal<string[]>([]);

  let bodyRef: HTMLTextAreaElement | undefined;
  let titleRef: HTMLInputElement | undefined;
  let tagRef: HTMLInputElement | undefined;
  let nameRef: HTMLInputElement | undefined;
  let highlightRef: HTMLPreElement | undefined;

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

  const visible = createMemo<Template[]>(() => {
    const dropped = new Set(hidden());
    return (templates() ?? []).filter((template) => !dropped.has(template.filename));
  });

  const selected = createMemo<Template | undefined>(() =>
    visible().find((template) => template.filename === selectedFile()),
  );

  /** Whether the name typed while creating a new one collides with an existing template. */
  const nameTaken = createMemo<boolean>(() => {
    const draft = toFileStem(draftName() ?? "");
    return draft !== "" && visible().some((template) => template.name === draft);
  });

  const editing = (): boolean => selected() !== undefined || draftName() !== null;

  /**
   * A draft that has just been restored. It marks the draft so a read from disk does not
   * clobber it, and it is set only for the duration of the restoring batch.
   */
  let restoring: Draft | undefined;

  /** Copy in the state that came from disk. This becomes the baseline for "unsaved". */
  const load = (draft: Draft): void => {
    batch(() => {
      setTitle(draft.title);
      setBody(draft.body);
      setTags(draft.tags);
      setBaseline(draft);
      setSaveStatus("idle");
    });
  };

  const current = (): Draft => ({ title: title(), body: body(), tags: tags() });

  // Read the contents of the selected template. Not while creating a new one: the body of
  // the previously selected template would flow into the empty form
  createEffect(() => {
    const file = selectedFile();
    if (!file || draftName() !== null || restoring) {
      return;
    }
    void (async () => {
      try {
        const detail = await typedInvoke("read_template", { filename: file });
        if (selectedFile() !== file) {
          return;
        }
        const titled = splitTitle(detail.body);
        load({ title: titled.title, body: titled.body, tags: detail.tags });
      } catch {
        if (selectedFile() === file) {
          load(EMPTY_DRAFT);
        }
      }
    })();
  });

  /** Whether it differs from what is on disk. This decides if the save button is enabled. */
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

  /**
   * Save explicitly. A template left half-written breaks every note made from it, so this
   * is not built to write out on each keystroke.
   */
  const save = (): void => {
    const filename = targetFilename();
    if (!filename || !canSave()) {
      return;
    }
    const draft = current();
    setSaveStatus("saving");

    void (async () => {
      try {
        await typedInvoke("save_template", {
          filename,
          body: joinTitle(draft.title, draft.body),
          tags: draft.tags,
        });
        batch(() => {
          setBaseline(draft);
          setSaveStatus("saved");
        });
        await refetch();
        // Once the name is settled, this turns from creating a new one into editing it
        if (draftName() !== null) {
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

  // Cmd+S / Ctrl+S. With the save button as the only way in, nothing can be kept while
  // writing. With Shift it is the app-wide "sync now", so it is not picked up here
  const onKeyDown = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };
  globalThis.addEventListener("keydown", onKeyDown);
  onCleanup(() => globalThis.removeEventListener("keydown", onKeyDown));

  /** Leave the editor holding a draft. Say it was discarded, and leave a way back. */
  const leaveEditor = (next: () => void): void => {
    if (!dirty()) {
      next();
      return;
    }
    const undo = { file: selectedFile(), name: draftName(), draft: current() };
    shell.showToast(t().templates.discarded, () => {
      restoring = undo.draft;
      batch(() => {
        setSelectedFile(undo.file);
        setDraftName(undo.name);
        setTitle(undo.draft.title);
        setBody(undo.draft.body);
        setTags(undo.draft.tags);
        setDetailOpen(true);
      });
      // The loading effect has finished running by the end of the batch
      restoring = undefined;
    });
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

  const select = (template: Template): void => {
    leaveEditor(() => {
      batch(() => {
        setDraftName(null);
        setSelectedFile(template.filename);
        setDetailOpen(true);
      });
    });
  };

  const remove = (template: Template): void => {
    batch(() => {
      setHidden((files) => [...files, template.filename]);
      setSelectedFile(null);
      setDetailOpen(false);
    });

    const commit = setTimeout(() => {
      void (async () => {
        await typedInvoke("delete_template", { filename: template.filename });
        await refetch();
        setHidden((files) => files.filter((file) => file !== template.filename));
      })();
    }, UNDO_MS);

    shell.showToast(t().templates.deleted, () => {
      clearTimeout(commit);
      setHidden((files) => files.filter((file) => file !== template.filename));
    });
  };

  const commitTagInput = (): void => {
    setTags((tagList) => addTemplateTag(tagList, tagInput()));
    setTagInput("");
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
    } else if (field === "tag") {
      setTagInput(next);
    } else {
      setBody(next);
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
            when={visible().length > 0}
            fallback={
              <div class="notes-empty">
                <Icon name="file-text" size={24} />
                <p class="notes-empty-title">{t().templates.empty}</p>
                <p class="notes-empty-body">{t().templates.emptyHint}</p>
              </div>
            }
          >
            <For each={visible()}>
              {(template) => (
                <button
                  type="button"
                  class="list-row"
                  classList={{ "list-row--selected": selected()?.filename === template.filename }}
                  onClick={() => select(template)}
                >
                  <span class="list-row-title">{template.name}</span>
                  <span class="list-row-meta">
                    {template.preview}
                    {/* Variables are not resolved in the list. This is where the definition
                        itself is read, so a `{{date}}` turned into today's date is
                        indistinguishable from a literal date */}
                    <For each={template.tags}>
                      {(tag) => (
                        <span class="tag-badge" classList={{ "tag-badge--var": hasVariable(tag) }}>
                          #{tag}
                        </span>
                      )}
                    </For>
                  </span>
                </button>
              )}
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
            <span class="detail-meta">
              <Show
                when={draftName() === null}
                fallback={
                  <input
                    type="text"
                    class="templates-name-input"
                    ref={nameRef}
                    placeholder={t().templates.namePlaceholder}
                    aria-label={t().templates.namePlaceholder}
                    value={draftName() ?? ""}
                    onInput={(e) => setDraftName(e.currentTarget.value)}
                  />
                }
              >
                {/* The name is the value written into a note's frontmatter. Changing it
                    later cuts the link to the notes grown from that template, so it is
                    only shown */}
                <span class="detail-created">{selected()?.name}</span>
              </Show>
              {/* While it is unsaved, say so before showing any save feedback */}
              <Show
                when={dirty()}
                fallback={
                  <Show when={saveStatus() !== "idle"}>
                    <span class="detail-save-status">
                      {saveStatus() === "saving" ? t().common.saving : t().common.saved}
                    </span>
                  </Show>
                }
              >
                <span class="detail-save-status templates-unsaved">{t().templates.unsaved}</span>
              </Show>
            </span>

            <div class="detail-actions">
              <button
                type="button"
                class="button-primary templates-save"
                disabled={!canSave()}
                onClick={save}
              >
                {t().common.save}
              </button>
              <Show when={selected()}>
                {(template) => (
                  <button
                    type="button"
                    class="icon-button"
                    title={t().common.delete}
                    aria-label={t().common.delete}
                    onClick={() => remove(template())}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                )}
              </Show>
            </div>
          </div>

          <Show when={nameTaken()}>
            <p class="templates-name-error">{t().templates.nameTaken}</p>
          </Show>

          <input
            type="text"
            class="note-title-input"
            ref={titleRef}
            placeholder={t().templates.titlePlaceholder}
            aria-label={t().templates.titlePlaceholder}
            value={title()}
            onFocus={() => setVarField("title")}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />

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
                    onClick={() => setTags((tagList) => tagList.filter((kept) => kept !== tag))}
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
              onInput={(e) => setBody(e.currentTarget.value)}
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
