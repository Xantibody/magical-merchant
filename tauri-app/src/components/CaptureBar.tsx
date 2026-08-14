import { createSignal, createMemo, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { isImeComposing } from "../lib/ime";
import { matchTagPrefix, tagDraftAt } from "../lib/tags";
import type { TagCount } from "../lib/tags";

interface CaptureBarProps {
  /** どのタブを見ていても Timeline に記録する。 */
  onSend: (text: string) => Promise<void>;
  /** 補完に出す、これまでに使ったタグ。 */
  knownTags?: TagCount[];
}

const MAX_ROWS = 6;
const MAX_SUGGESTIONS = 6;

export default function CaptureBar(props: CaptureBarProps): JSX.Element {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  /** 補完を出す位置。カーソルが動いたら測り直す。 */
  const [caret, setCaret] = createSignal(0);
  const [cursor, setCursor] = createSignal(0);
  const [dismissed, setDismissed] = createSignal(false);

  let textareaRef: HTMLTextAreaElement | undefined;

  /** 入力に合わせて高さを伸ばす。上限を超えたらスクロールに切り替える。 */
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

  /** 打ちかけの語をそのまま新しいタグとして確定できる。 */
  const isNew = createMemo(() => {
    const typing = draft();
    return Boolean(typing) && !suggestions().some((s) => s.tag === typing);
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
    const trimmed = text().trim();
    if (!trimmed || sending()) {
      return;
    }
    setSending(true);
    try {
      await props.onSend(trimmed);
      setText("");
      setDismissed(false);
      queueMicrotask(autoGrow);
    } finally {
      setSending(false);
    }
  };

  const trackCaret = (el: HTMLTextAreaElement): void => {
    setCaret(el.selectionStart);
    setCursor(0);
  };

  const onKeyDown = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void => {
    // 変換確定の Enter は IME のもの。送信にもタグ確定にも使わない (#102)
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
      // 補完が開いている間の Enter はタグの確定。記録は閉じてから
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
        <div class="tag-suggest" role="listbox" aria-label="タグ候補">
          <span class="tag-suggest-label">タグ</span>
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
              +「#{draft()}」を新規タグとして確定
            </button>
          </Show>
        </div>
      </Show>

      <textarea
        ref={textareaRef}
        rows={1}
        class="capture-input"
        placeholder="What's on your mind?"
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
        onClick={() => void send()}
      >
        <Icon name="paper-plane-tilt" size={16} />
        <span class="capture-send-label">Send</span>
      </button>
    </div>
  );
}
