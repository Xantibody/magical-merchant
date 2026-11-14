import { createResource, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import CaptureBar from "./CaptureBar";
import Icon from "./Icon";
import { typedInvoke } from "../lib/commands";
import { t } from "../lib/i18n";
import { MODE_ICONS, ROUTES } from "../lib/routes";

interface CapturePillProps {
  /** Records the line; a refusal is left to throw, and the pill keeps what was typed. */
  onSend: (text: string) => Promise<void>;
  /** ⌘Enter, or the ring's "make it a Note": the line becomes a Note's title. */
  onPromote: (text: string) => Promise<void>;
  /** Esc: the pill goes and the draft stays for the next time. */
  onClose: () => void;
  onError: () => void;
  /** The words under the pill: how it sends and closes, or when the last line went. */
  hint: string;
  /** The `/` menu's rows; where there is no app around the pill they simply close it. */
  onSearch?: () => void;
  onNewNote?: () => void;
  onJumpToDate?: (trigger: HTMLElement) => void;
}

/**
 * The one-line window in the place pill's own shape and words, wherever it floats: over another
 * app (the OS key, 38 / 67), over the app's own page (a held pill's ring, 68), and as the
 * harness's stand-in for the OS window. Scrawl's mark where the places stand, then the same
 * field and the same send as Scrawl's stretched pill, and one quiet line under it. The draft is
 * the field's own (CaptureBar keeps it on the device), so a line begun in one finishes in any.
 */
export default function CapturePill(props: CapturePillProps): JSX.Element {
  let pill: HTMLDivElement | undefined;
  // The tags used anywhere, most used first, for the field's completion
  const [known] = createResource(async () => {
    try {
      const used = await typedInvoke("count_tags");
      return used.map((usage) => ({ tag: usage.tag, count: usage.notes + usage.entries }));
    } catch {
      return [];
    }
  });

  // It was asked for to be written in, so the field has the focus the moment it appears
  onMount(() => {
    pill?.querySelector<HTMLTextAreaElement>(".capture-input")?.focus();
  });

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a dialog's own Esc
    <div
      class="capture-pill"
      ref={pill}
      role="dialog"
      aria-label={t().palm.jot}
      onKeyDown={(e) => {
        // The field's own Esc folds a completion first and marks the key as handled
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div class="capture-pill-row">
        <span class="capture-pill-mark" aria-hidden="true">
          <Icon name={MODE_ICONS[ROUTES.SCRAWL]} size={22} />
        </span>
        <CaptureBar
          knownTags={known() ?? []}
          onSend={props.onSend}
          onPromote={props.onPromote}
          onError={props.onError}
          onSearch={() => (props.onSearch ?? props.onClose)()}
          onNewNote={() => (props.onNewNote ?? props.onClose)()}
          onJumpToDate={(trigger) =>
            props.onJumpToDate ? props.onJumpToDate(trigger) : props.onClose()
          }
        />
      </div>
      <Show when={props.hint}>
        <p class="capture-pill-hint">{props.hint}</p>
      </Show>
    </div>
  );
}
