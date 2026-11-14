import { createEffect, createSignal, createMemo, For, on, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { createRingPress } from "./Ring";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { modifierLabel } from "../lib/shortcuts";
import { matchTagPrefix, sameTag, tagDraftAt } from "../lib/tags";
import type { TagCount } from "../lib/tags";

interface CaptureBarProps {
  /** Records into Scrawl whichever tab is open. */
  onSend: (text: string) => Promise<void>;
  /** ⌘Enter: the text becomes a Note's title and the Note opens to write. */
  onPromote: (text: string) => Promise<void>;
  onError: () => void;
  /** The tags used so far, offered as completions. */
  knownTags?: TagCount[];
  /** The rows of the / menu. */
  onSearch: () => void;
  onNewNote: () => void;
  /** The line hands itself over as the trigger: the calendar is a popover (`Popover.tsx`). */
  onJumpToDate: (trigger: HTMLElement) => void;
  /** A line taken back after sending comes back here, to be fixed and sent again (36). */
  refill?: { text: string } | null;
  /**
   * Empty, the field's round button searches instead of sending nothing: Scrawl's one way into
   * search, under the thumb. Scrawl's field only.
   */
  searchWhenEmpty?: boolean;
  /** A tag pressed beside the field while a line is typed (71): it joins the line at the caret. */
  addTag?: { tag: string } | null;
  /** Said when the field takes or loses the focus: the tags beside it turn into ones to add. */
  onFocusChange?: (focused: boolean) => void;
}

interface MenuRow {
  id: string;
  label: string;
  run: (line: HTMLElement) => void;
}

/** Past five lines the field scrolls: the list it writes into stays in sight above it. */
const MAX_ROWS = 5;
const MAX_SUGGESTIONS = 6;

/**
 * The whole line being one `/word`, the only shape that can call the menu. The full-width
 * slash is what a Japanese keyboard gives while the IME is on. A space ends it, so a line
 * that begins with a path stays a record.
 */
const SLASH_LINE = /^[/／](?<word>\S*)$/u;

/**
 * The half-typed capture. An entry is written only on send, so until then the text lived
 * in a signal alone and went with the process when the phone put the app away.
 * localStorage is synchronous and stays. It is never sent on its own: an entry is a
 * timestamped record, and a half-typed one is not what was meant. It waits for the return.
 */
const DRAFT_KEY = "scrawl-draft";

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Best-effort: a device without localStorage simply forgets the text with the process. */
function rememberDraft(value: string): void {
  try {
    if (value) {
      localStorage.setItem(DRAFT_KEY, value);
    } else {
      localStorage.removeItem(DRAFT_KEY);
    }
  } catch {
    // Quota exceeded, or no storage
  }
}

export default function CaptureBar(props: CaptureBarProps): JSX.Element {
  const [text, setText] = createSignal(readDraft());
  const [sending, setSending] = createSignal(false);
  /** Where the completion is anchored. Measured again whenever the cursor moves. */
  const [caret, setCaret] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);

  let textareaRef: HTMLTextAreaElement | undefined;

  /**
   * Whether the stylesheet sizes the line (`field-sizing`, Chrome 123 and Safari 26.2). Where it
   * does, the line grows within the layout a key causes anyway; measuring it here as well forced
   * a second, synchronous layout of the day list below on every key, IME composition included.
   */
  const sizesItself = CSS.supports("field-sizing", "content");

  /** Grows the height with the input where the browser cannot. Scrolls past the limit. */
  const autoGrow = (): void => {
    const el = textareaRef;
    if (sizesItself || !el) {
      return;
    }
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  };

  // A line taken back lands in the field as it was sent, caret at its end
  createEffect(
    on(
      () => props.refill,
      (refill) => {
        if (!refill) {
          return;
        }
        setText(refill.text);
        rememberDraft(refill.text);
        queueMicrotask(() => {
          autoGrow();
          textareaRef?.focus();
          textareaRef?.setSelectionRange(refill.text.length, refill.text.length);
        });
      },
      { defer: true },
    ),
  );

  // A tag pressed beside the field joins the line where the caret is, set apart by spaces, and
  // the caret goes on after it: the next word or tag follows without a tap
  createEffect(
    on(
      () => props.addTag,
      (add) => {
        const el = textareaRef;
        if (!add || !el) {
          return;
        }
        const value = text();
        const at = Math.min(el.selectionStart, value.length);
        const before = value.slice(0, at);
        const gap = before === "" || /\s$/u.test(before) ? "" : " ";
        const insert = `${gap}#${add.tag} `;
        const next = `${before}${insert}${value.slice(at)}`;
        setText(next);
        rememberDraft(next);
        setDismissed(true);
        queueMicrotask(() => {
          el.focus();
          el.setSelectionRange(at + insert.length, at + insert.length);
          autoGrow();
        });
      },
      { defer: true },
    ),
  );

  /** Nothing typed and a search to offer: the round button is the search's (26). */
  const searching = (): boolean => props.searchWhenEmpty === true && !text().trim();

  const draft = createMemo(() => (dismissed() ? null : tagDraftAt(text(), caret())));

  const suggestions = createMemo<TagCount[]>(() => {
    const typing = draft();
    if (typing === null) {
      return [];
    }
    return matchTagPrefix(props.knownTags ?? [], typing).slice(0, MAX_SUGGESTIONS);
  });

  /**
   * The half-typed word can be committed as a new tag as it stands.
   * It is not new if a candidate differs only in case: listing it as well would
   * make creating a tag that already exists look like the thing to do.
   */
  const isNew = createMemo(() => {
    const typing = draft();
    return typing !== null && typing !== "" && !suggestions().some((s) => sameTag(s.tag, typing));
  });

  /**
   * AIDEV-NOTE: filtered by the row names alone, and a word that matches none closes the menu.
   * Reading `/tmp` as a search instead would take a line away from the person recording it.
   */
  const menu = createMemo<MenuRow[]>(() => {
    const word = dismissed() ? undefined : SLASH_LINE.exec(text())?.groups?.word;
    if (word === undefined) {
      return [];
    }
    const rows: MenuRow[] = [
      { id: "search", label: t().capture.menuSearch, run: () => props.onSearch() },
      { id: "note", label: t().capture.menuNote, run: () => props.onNewNote() },
      { id: "date", label: t().capture.menuDate, run: (line) => props.onJumpToDate(line) },
    ];
    return rows.filter((row) => row.label.toLowerCase().includes(word.toLowerCase()));
  });

  const rows = createMemo(() =>
    menu().length > 0 ? menu().length : suggestions().length + (isNew() ? 1 : 0),
  );

  /** The line is the command, so choosing it leaves nothing to record. */
  const pick = (row: MenuRow): void => {
    setText("");
    rememberDraft("");
    queueMicrotask(autoGrow);
    if (textareaRef) {
      row.run(textareaRef);
    }
  };

  const complete = (tag: string): void => {
    const typing = draft();
    if (typing === null) {
      return;
    }
    const at = caret();
    const start = at - typing.length;
    const completed = `${text().slice(0, start)}${tag} ${text().slice(at)}`;
    setText(completed);
    setDismissed(true);
    queueMicrotask(() => {
      const to = start + tag.length + 1;
      textareaRef?.setSelectionRange(to, to);
      textareaRef?.focus();
      autoGrow();
    });
  };

  const commitRow = (): void => {
    const row = menu()[cursor()];
    if (row) {
      pick(row);
      return;
    }
    const picked = suggestions()[cursor()];
    if (picked) {
      complete(picked.tag);
      return;
    }
    const typing = draft();
    if (typing) {
      complete(typing);
    }
  };

  const submit = async (handOver: (text: string) => Promise<void>): Promise<void> => {
    const submitted = text();
    const trimmed = submitted.trim();
    if (!trimmed || sending()) {
      return;
    }
    setSending(true);
    try {
      await handOver(trimmed);
      if (text() === submitted) {
        setText("");
        rememberDraft("");
        setDismissed(false);
        queueMicrotask(autoGrow);
      }
    } catch {
      props.onError();
    } finally {
      setSending(false);
    }
  };

  /**
   * Records, then hands the focus back to the field: the next line can follow at once, and on a
   * phone the keyboard stays up. A promotion leaves the screen instead, so it does not.
   */
  const send = async (): Promise<void> => {
    await submit(props.onSend);
    textareaRef?.focus();
  };

  /**
   * Send slid up (5): the ⌘Enter a phone has no key for, as one pill over the thumb. Letting go
   * on send always records, however slow the press: it is the app's most frequent act, and a
   * firm tap must never hold a line back. A slide up, or a press held long enough to show the
   * pill, offers the Note; letting go off both keeps the line in the field.
   */
  const sendRing = createRingPress({
    holdMs: 320,
    slideOpens: true,
    tap: () => {
      void send();
    },
    hint: (onSend) => (onSend ? t().reach.sendRelease : t().reach.sendKeep),
    choices: () => [
      {
        id: "note",
        icon: "note-pencil",
        label: t().reach.asNote,
        run: () => {
          void submit(props.onPromote);
        },
      },
    ],
  });

  const trackCaret = (el: HTMLTextAreaElement): void => {
    setCaret(el.selectionStart);
    setCursor(0);
  };

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void => {
    // During a conversion every key is the IME's: Enter ends it, the arrows choose (#102)
    if (isImeComposing(e)) {
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit(props.onPromote);
      return;
    }
    if (rows() > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, rows() - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      // While a list is open, Enter picks from it. Recording waits until it closes
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        commitRow();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div class="capture-bar">
      <Show when={menu().length > 0}>
        <div class="tag-suggest" role="listbox" aria-label={t().capture.menuLabel}>
          <For each={menu()}>
            {(row, i) => (
              <button
                type="button"
                role="option"
                aria-selected={cursor() === i()}
                class="tag-suggest-row"
                classList={{ "tag-suggest-row--active": cursor() === i() }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(row);
                }}
              >
                {row.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={menu().length === 0 && rows() > 0}>
        <div class="tag-suggest" role="listbox" aria-label={t().capture.suggestLabel}>
          <span class="tag-suggest-label">{t().common.tags}</span>
          <For each={suggestions()}>
            {(suggestion, i) => (
              <button
                type="button"
                role="option"
                aria-selected={cursor() === i()}
                class="tag-suggest-row"
                classList={{ "tag-suggest-row--active": cursor() === i() }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(suggestion.tag);
                }}
              >
                <span>#{suggestion.tag}</span>
                <span class="tag-suggest-count">{suggestion.count}</span>
              </button>
            )}
          </For>
          <Show when={isNew()}>
            <button
              type="button"
              role="option"
              aria-selected={cursor() === suggestions().length}
              class="tag-suggest-row tag-suggest-row--new"
              classList={{ "tag-suggest-row--active": cursor() === suggestions().length }}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(draft() ?? "");
              }}
            >
              {t().capture.newTag(draft() ?? "")}
            </button>
          </Show>
        </div>
      </Show>

      <textarea
        ref={textareaRef}
        rows={1}
        class="capture-input"
        aria-label={t().capture.label}
        placeholder={t().capture.placeholder}
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          rememberDraft(e.currentTarget.value);
          setDismissed(false);
          trackCaret(e.currentTarget);
          autoGrow();
        }}
        onClick={(e) => trackCaret(e.currentTarget)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onFocus={() => props.onFocusChange?.(true)}
        onBlur={() => props.onFocusChange?.(false)}
      />
      <Show
        when={!searching()}
        fallback={
          <button
            type="button"
            class="capture-send capture-send--search"
            title={t().palm.search}
            aria-label={t().palm.search}
            onClick={() => props.onSearch()}
          >
            <Icon name="magnifying-glass" size={18} />
          </button>
        }
      >
        <button
          type="button"
          class="capture-send ring-trigger"
          aria-label={t().capture.send}
          disabled={sending() || !text().trim()}
          {...sendRing.handlers}
          // The press must not take the focus: on a phone that drops the keyboard, and the
          // field the next line goes into would have to be found again
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (sendRing.shouldClick()) {
              void send();
            }
          }}
        >
          <Icon name="paper-plane-tilt" size={18} />
        </button>
        {sendRing.view()}
      </Show>
      {/* What the field also answers to. Only while writing, and only where there are keys */}
      <span class="capture-hint" aria-hidden="true">
        {t().capture.hint(modifierLabel())}
      </span>
    </div>
  );
}
