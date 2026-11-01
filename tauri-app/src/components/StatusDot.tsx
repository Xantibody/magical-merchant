import { Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import { useShell } from "../lib/shell";
import type { NoteState } from "../lib/shell";
import type { SaveStatus } from "../lib/note-session";
import type { SyncStatus } from "../lib/sync";
import { t } from "../lib/i18n";
import { shortcutLabel } from "../lib/shortcuts";

/** What the dot says: everything landed, something is on its way, or something failed. */
export type DotTone = "ok" | "busy" | "failed";

/**
 * Folds the save and the sync into one of three tones. A failure wins over work in flight,
 * because a red dot is the only one that asks for anything. `needs-setup` is not a failure:
 * a device that never asked for sync would otherwise stay red forever.
 */
export function dotTone(save: SaveStatus, sync: SyncStatus): DotTone {
  if (save === "failed" || sync === "error" || sync === "signed-out") {
    return "failed";
  }
  if (save === "saving" || sync === "syncing") {
    return "busy";
  }
  return "ok";
}

/** The dot in words, for the tooltip and the screen reader. */
export function dotLabel(tone: DotTone, sync: SyncStatus): string {
  if (tone === "failed") {
    return t().status.failed;
  }
  if (tone === "busy") {
    return t().status.busy;
  }
  return sync === "needs-setup" ? t().common.saved : t().status.ok;
}

interface DotProps {
  sync: SyncStatus;
  onOpen: (trigger: HTMLElement) => void;
}

/**
 * The button itself. The header of a narrow window uses it alone. The mark is a child, not
 * `::after`, because `::after` is where the hint layer draws its badge.
 */
export function StatusDotButton(props: DotProps): JSX.Element {
  const shell = useShell();
  const tone = (): DotTone => dotTone(shell.saveState().status, props.sync);
  const label = (): string => `${t().status.label}: ${dotLabel(tone(), props.sync)}`;

  return (
    <button
      type="button"
      class="status-dot"
      data-tone={tone()}
      title={label()}
      aria-label={label()}
      aria-expanded={shell.popover() === "sync"}
      data-hint-key={shortcutLabel("syncNow")}
      onClick={(e) => props.onOpen(e.currentTarget)}
    >
      <span class="status-dot-mark" />
    </button>
  );
}

interface LinksProps {
  onSettings: () => void;
  onKeys: () => void;
}

/** The two rare destinations. Beside the dot on hover, inside the details where there is none. */
export function StatusLinks(props: LinksProps): JSX.Element {
  return (
    <>
      <button type="button" class="status-link" onClick={() => props.onSettings()}>
        {t().header.settings}
      </button>
      <span aria-hidden="true">·</span>
      <button type="button" class="status-link" onClick={() => props.onKeys()}>
        {t().status.keys}
      </button>
    </>
  );
}

/**
 * State fixed to the window's lower right, outside the paper (ADR 0011). A wide window only:
 * a narrow one has the bottom tabs and the capture dock there, so its dot is in the header.
 */
export default function StatusDot(props: DotProps & LinksProps): JSX.Element {
  return (
    <div class="status-dot-area">
      <div class="status-dot-links">
        <StatusLinks onSettings={props.onSettings} onKeys={props.onKeys} />
      </div>
      <StatusDotButton sync={props.sync} onOpen={props.onOpen} />
    </div>
  );
}

function saveLine(status: SaveStatus, at: string): string {
  switch (status) {
    case "saving": {
      return t().common.saving;
    }
    case "failed": {
      return t().status.saveFailed;
    }
    case "saved":
    case "savedAt": {
      return t().notes.savedAt(at);
    }
    default: {
      return "";
    }
  }
}

/** A state that is on. Pressing it leads to its switch in the panel. */
function StateRow(props: { icon: IconName; label: string; onOpen: () => void }): JSX.Element {
  return (
    <button type="button" class="status-details-row" onClick={() => props.onOpen()}>
      <Icon name={props.icon} size={13} />
      {props.label}
    </button>
  );
}

/**
 * The open note's part of the details: everything the bottom bar used to carry. ADR 0011 names
 * only the save time and the revert; the version, the commit and the states that are on have
 * no other home while the writing screen keeps the meta line and the panel shut (ADR 0012).
 */
function NoteDetails(props: { note: NoteState; run: (action: () => void) => void }): JSX.Element {
  const note = (): NoteState => props.note;
  return (
    <>
      <Show when={note().version}>
        {(version) => <p class="status-details-line">{version()}</p>}
      </Show>
      <Show when={note().comparing}>
        {(comparing) => (
          <StateRow
            icon="clock-counter-clockwise"
            label={comparing()}
            onOpen={() => props.run(note().openHistory)}
          />
        )}
      </Show>
      <Show when={note().map}>
        <StateRow
          icon="tree-structure"
          label={t().notes.map}
          onOpen={() => props.run(note().openSettings)}
        />
      </Show>
      <Show when={note().examples}>
        <StateRow
          icon="file-text"
          label={t().notes.examples}
          onOpen={() => props.run(note().openSettings)}
        />
      </Show>
      <Show when={note().canCommit}>
        <button
          type="button"
          class="status-details-row"
          data-hint-key={shortcutLabel("codexCommit")}
          onClick={() => props.run(note().commit)}
        >
          <Icon name="book-bookmark" size={13} />
          {t().codex.commit}
        </button>
      </Show>
      <Show when={note().canRevert}>
        <button
          type="button"
          class="status-details-row"
          data-hint-key={shortcutLabel("noteRevert")}
          onClick={() => props.run(note().revert)}
        >
          <Icon name="arrow-counter-clockwise" size={13} />
          {t().notes.revert}
        </button>
      </Show>
    </>
  );
}

/** What pressing the dot adds above the sync details. */
export function StatusDetails(props: { onClose: () => void }): JSX.Element {
  const shell = useShell();
  const save = (): string => saveLine(shell.saveState().status, shell.saveState().at);
  const run = (action: () => void): void => {
    props.onClose();
    action();
  };

  return (
    <div class="status-details">
      <Show when={save()}>{(line) => <p class="status-details-save">{line()}</p>}</Show>
      <Show when={shell.noteState()}>{(note) => <NoteDetails note={note()} run={run} />}</Show>
    </div>
  );
}
