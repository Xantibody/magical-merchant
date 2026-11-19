import { Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import type { SaveStatus } from "../lib/note-session";

interface NoteStatusRowProps {
  saveStatus: SaveStatus;
  /** The clock time of the last save. Shown once "saved" settles into `savedAt`. */
  savedAt: string;
  /** Whether the map is laid alongside. */
  mapShown: boolean;
  /** Whether a template's examples are shown in the body. */
  examplesShown: boolean;
  canCommit: boolean;
  canRevert: boolean;
  /** A state pill leads to its switch on the panel's settings tab. */
  onOpenSettings: () => void;
  onCommit: () => void;
  onRevert: () => void;
}

/**
 * The phone's state row: the save, the view states that are on, and the two actions that would do
 * something now. A wide window says the same in the dot's details, so it is hidden there (CSS).
 */
export default function NoteStatusRow(props: NoteStatusRowProps): JSX.Element {
  return (
    <div class="detail-status-row">
      <Show when={props.saveStatus !== "idle"}>
        <span class="detail-save-status" data-status={props.saveStatus}>
          <Show when={props.saveStatus === "saving"}>
            <Icon name="circle-notch" size={11} />
          </Show>
          <Show when={props.saveStatus === "saved"}>
            <Icon name="check" size={11} />
          </Show>
          {props.saveStatus === "saving" ? t().common.saving : null}
          {props.saveStatus === "saved" ? t().common.saved : null}
          {props.saveStatus === "savedAt" ? t().notes.savedAt(props.savedAt) : null}
          {props.saveStatus === "failed" ? t().status.saveFailed : null}
        </span>
      </Show>
      <Show when={props.mapShown}>
        <button type="button" class="detail-state-pill" onClick={() => props.onOpenSettings()}>
          <Icon name="tree-structure" size={12} />
          {t().notes.map}
        </button>
      </Show>
      <Show when={props.examplesShown}>
        <button type="button" class="detail-state-pill" onClick={() => props.onOpenSettings()}>
          <Icon name="file-text" size={12} />
          {t().notes.examples}
        </button>
      </Show>
      <span class="detail-status-actions">
        <Show when={props.canCommit}>
          <button type="button" class="detail-action-pill" onClick={() => props.onCommit()}>
            <Icon name="book-bookmark" size={13} />
            {t().codex.commit}
          </button>
        </Show>
        <Show when={props.canRevert}>
          <button type="button" class="detail-action-pill" onClick={() => props.onRevert()}>
            <Icon name="arrow-counter-clockwise" size={13} />
            {t().notes.revert}
          </button>
        </Show>
      </span>
    </div>
  );
}
