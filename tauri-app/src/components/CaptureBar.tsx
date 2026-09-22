import { createSignal, createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import { matchTagPrefix, sameTag, tagDraftAt } from "../lib/tags";
import type { TagCount } from "../lib/tags";

interface CaptureBarProps {
  /** Records into Scrawl whichever tab is open. */
  onSend: (text: string) => Promise<void>;
  onError: () => void;
  /** The tags used so far, offered as completions. */
  knownTags?: TagCount[];
}

const MAX_ROWS = 6;
const MAX_SUGGESTIONS = 6;

export default function CaptureBar(props: CaptureBarProps): JSX.Element {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  /** Where the completion is anchored. Measured again whenever the cursor moves. */
  const [caret, setCaret] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);

  let textareaRef: HTMLTextAreaElement | undefined;

  /** Grows the height with the input. Switches to scrolling once it passes the limit. */
  const autoGrow = (): void => {
    const el = textareaRef;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || 22;
    el.style.height = `${Math.min(el.scrollHeight, line * MAX_ROWS)}px`;
  };

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

  const rows = createMemo(() => suggestions().length + (isNew() ? 1 : 0));

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

  const send = async (): Promise<void> => {
    const submitted = text();
    const trimmed = submitted.trim();
    if (!trimmed || sending()) {
      return;
    }
    setSending(true);
    try {
      await props.onSend(trimmed);
      if (text() === submitted) {
        setText("");
        setDismissed(false);
        queueMicrotask(autoGrow);
      }
    } catch {
      props.onError();
    } finally {
      setSending(false);
    }
  };

  const trackCaret = (el: HTMLTextAreaElement): void => {
    setCaret(el.selectionStart);
    setCursor(0);
  };

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void => {
    // The Enter that ends IME conversion is the IME's. It neither sends nor picks a tag (#102)
    if (e.key === "Enter" && isImeComposing(e)) {
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
      // While the completion is open, Enter picks a tag. Recording waits until it closes
      if (e.key === "Enter" && !e.shiftKey) {
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
      <Show when={rows() > 0}>
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
        placeholder={t().capture.placeholder}
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setDismissed(false);
          trackCaret(e.currentTarget);
          autoGrow();
        }}
        onClick={(e) => trackCaret(e.currentTarget)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        class="capture-send"
        aria-label="Send"
        disabled={sending() || !text().trim()}
        onClick={() => {
          void send();
        }}
      >
        <Icon name="paper-plane-tilt" size={16} />
        <span class="capture-send-label">Send</span>
      </button>
    </div>
  );
}
