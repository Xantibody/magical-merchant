import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";

interface CaptureBarProps {
  /** どのタブを見ていても Timeline に記録する。 */
  onSend: (text: string) => Promise<void>;
}

const MAX_ROWS = 6;

export default function CaptureBar(props: CaptureBarProps): JSX.Element {
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);

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

  const send = async (): Promise<void> => {
    const trimmed = text().trim();
    if (!trimmed || sending()) {
      return;
    }
    setSending(true);
    try {
      await props.onSend(trimmed);
      setText("");
      queueMicrotask(autoGrow);
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="capture-bar">
      <textarea
        ref={textareaRef}
        rows={1}
        class="capture-input"
        placeholder="What's on your mind?"
        value={text()}
        onInput={(e) => {
          setText(e.currentTarget.value);
          autoGrow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
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
