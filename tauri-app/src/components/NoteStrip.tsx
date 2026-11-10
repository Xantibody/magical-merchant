import { Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { NoteKind } from "../lib/commands";
import { t } from "../lib/i18n";
import { useShell } from "../lib/shell";
import { shortcutLabel } from "../lib/shortcuts";

interface NoteStripProps {
  kind: NoteKind;
  /** Whether the writing screen is up. The strip then holds only "done". */
  writing: boolean;
  mapOpen: boolean;
  /** Whether a version is being compared. The body is read-only then, so writing is not offered. */
  historyOpen: boolean;
  /** The phone's way back to the list. */
  onBack: () => void;
  onToggleMap: () => void;
  onWrite: () => void;
  onDone: () => void;
  onTogglePanel: () => void;
}

/**
 * The strip over the page. The viewer: back (a phone's) · map · write · tidy.
 * The writing screen: done. Keys live in the titles.
 */
export default function NoteStrip(props: NoteStripProps): JSX.Element {
  const shell = useShell();

  /** The panel's name, which is also what its toggle and the phone's meta line say. */
  const panelLabel = (): string => (props.kind === "codex" ? t().codex.panel : t().notes.panel);

  return (
    <div class="note-strip">
      <Show
        when={props.writing}
        fallback={
          <>
            <button
              type="button"
              class="icon-button detail-back"
              aria-label={t().notes.backToList}
              onClick={() => props.onBack()}
            >
              <Icon name="arrow-left" size={18} />
            </button>
            <span class="note-strip-fill" />
            <button
              type="button"
              class="icon-button"
              aria-pressed={props.mapOpen}
              title={`${t().notes.map} ${shortcutLabel("noteMap")}`}
              aria-label={t().notes.map}
              onClick={() => props.onToggleMap()}
            >
              <Icon name="tree-structure" size={17} />
            </button>
            <button
              type="button"
              class="icon-button"
              title={`${t().viewer.write} ↵`}
              aria-label={t().viewer.write}
              disabled={props.historyOpen}
              onClick={() => props.onWrite()}
            >
              <Icon name="pencil" size={17} />
            </button>
          </>
        }
      >
        <button
          type="button"
          class="icon-button"
          title={`${t().viewer.done} Esc`}
          aria-label={t().viewer.done}
          onClick={() => props.onDone()}
        >
          <Icon name="check" size={17} />
        </button>
        <span class="note-strip-fill" />
      </Show>
      {/* The one visible way into the panel; ⌘. is the other. Neither works while
        writing: nothing interrupts the writing hand */}
      <Show when={!props.writing}>
        <button
          type="button"
          class="icon-button note-panel-toggle"
          aria-expanded={shell.notePanelPinned()}
          title={`${t().viewer.tidy} ${shortcutLabel("noteActions")}`}
          aria-label={panelLabel()}
          data-hint-key={shortcutLabel("noteActions")}
          onClick={() => props.onTogglePanel()}
        >
          <Icon name="dots-three" size={18} />
        </button>
      </Show>
    </div>
  );
}
