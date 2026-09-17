import { createSignal, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { t } from "../lib/i18n";
import { isImeComposing } from "../lib/ime";
import "../styles/versions.css";

interface CommitPopoverProps {
  /** `null` は一言なし。空欄のまま刻んでよい。 */
  onCommit: (message: string | null) => void;
  onClose: () => void;
}

/**
 * 版を刻む直前の一言。入力欄 1 つで、Enter がそのまま「刻む」。
 * 空でも刻める — 一言を強いると、刻むこと自体が億劫になる。
 */
export default function CommitPopover(props: CommitPopoverProps): JSX.Element {
  const [message, setMessage] = createSignal("");
  let inputRef: HTMLInputElement | undefined;

  onMount(() => inputRef?.focus());

  const commit = (): void => {
    const trimmed = message().trim();
    props.onCommit(trimmed === "" ? null : trimmed);
  };

  return (
    <div class="popover commit-popover" role="dialog" aria-label={t().codex.commit}>
      <input
        ref={inputRef}
        type="text"
        class="commit-input"
        placeholder={t().codex.commitPlaceholder}
        aria-label={t().codex.commitPlaceholder}
        value={message()}
        onInput={(e) => setMessage(e.currentTarget.value)}
        onKeyDown={(e) => {
          // 変換確定の Enter は IME のもの (#102)
          if (e.key === "Enter" && !isImeComposing(e)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            props.onClose();
          }
        }}
      />
      <button type="button" class="button-primary" onClick={commit}>
        {t().codex.commitYes}
      </button>
    </div>
  );
}
