import { createEffect, createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import Icon from "./Icon";
import type { NoteKind } from "../lib/commands";
import { t } from "../lib/i18n";
import { shortcutLabel } from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";

interface NoteMenuProps {
  /** Whether it is open. The surface owns this (to make it exclusive with Cmd-. and other popovers). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which surface the note is on. Only a Note can become a Codex. */
  kind: NoteKind;
  mapOpen: boolean;
  readOnly: boolean;
  /** Whether the note has template examples. The toggle is not shown for one that has none. */
  hasExamples: boolean;
  examplesShown: boolean;
  /** Whether this device still holds the body from before the edit. Unpressable without it. */
  revertable: boolean;
  onToggleMap: () => void;
  onToggleReadOnly: () => void;
  onToggleExamples: () => void;
  onRevert: () => void;
  onInfo: () => void;
  onPromote: () => void;
  /** Codex only. Commit the current draft as a version. */
  onCommit: () => void;
  /** Codex only. Show the version list and the diff where the body is. */
  onHistory: () => void;
  onDelete: () => void;
}

function Row(props: {
  icon: JSX.Element;
  label: string;
  shortcut?: ShortcutName;
  danger?: boolean;
  disabled?: boolean;
  /** A row that stays open when pressed. Set only when the confirmation takes over the same width. */
  keepOpen?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <DropdownMenu.Item
      class="note-menu-row"
      classList={{ "note-menu-row--danger": props.danger }}
      disabled={props.disabled}
      closeOnSelect={!props.keepOpen}
      onSelect={() => props.onClick()}
    >
      {props.icon}
      <span class="note-menu-label">{props.label}</span>
      <Show when={props.shortcut}>
        {(name) => <span class="note-menu-key">{shortcutLabel(name())}</span>}
      </Show>
    </DropdownMenu.Item>
  );
}

/**
 * The place for the rarely pressed actions that act on one note.
 *
 * The buttons that used to be always visible were folded in here because each is
 * used only often enough to get in the way of "open, then write". Frequent users
 * have keys, so they never need to open this menu. Only the dangerous delete is
 * set apart by colour and placed at the bottom.
 *
 * "Make it a Codex" alone gets a confirmation instead of Undo. Unlike delete
 * there is no way back (there is no Codex to Note path), so it cannot be
 * reverted once pressed.
 */
export default function NoteMenu(props: NoteMenuProps): JSX.Element {
  const [confirming, setConfirming] = createSignal(false);

  // The confirmation lives only while the menu is open. There are several ways to
  // close it (Cmd-., outside, running a row), so it folds by watching the open state itself
  createEffect(() => {
    if (!props.open) {
      setConfirming(false);
    }
  });

  return (
    <DropdownMenu
      open={props.open}
      onOpenChange={(open) => props.onOpenChange(open)}
      // No backdrop that stops a writing hand. What is behind stays readable and scrolling stays alive
      modal={false}
      placement="bottom-end"
      gutter={6}
    >
      {/* Per-note actions fold into this one place. None is pressed often */}
      <DropdownMenu.Trigger
        class="icon-button note-menu-button"
        title={t().notes.actions}
        aria-label={t().notes.actions}
        data-hint-key={shortcutLabel("noteActions")}
      >
        <Icon name="dots-three" size={17} />
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content class="popover note-menu">
          <Show
            when={!confirming()}
            fallback={
              <div class="note-menu-confirm">
                {/* Say what is gained before saying there is no way back. That is
                    what decides whether to press */}
                <span class="note-menu-confirm-title">
                  <Icon name="book" size={15} />
                  {t().codex.promote}
                </span>
                <p class="note-menu-confirm-label">{t().codex.promoteBody1}</p>
                <p class="note-menu-confirm-label">
                  {t().codex.promoteBody2}
                  <strong>{t().codex.promoteBody2Strong}</strong>
                </p>
                {/* The moment the confirmation appears, focus is stranded on the
                    menu row that vanished. The arrow keys only walk the menu rows,
                    and leaving them folds the whole menu, so someone who opened it
                    by keyboard alone can neither press nor cancel. The side that
                    showed it takes focus over. Deferring to a microtask waits for
                    the component to finish handing out focus */}
                <button
                  type="button"
                  class="button-primary"
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onClick={() => props.onPromote()}
                >
                  {t().codex.promoteYes}
                </button>
                <button type="button" class="button-secondary" onClick={() => setConfirming(false)}>
                  {t().common.back}
                </button>
              </div>
            }
          >
            <Row
              icon={<Icon name="tree-structure" size={15} />}
              label={props.mapOpen ? t().notes.hideMap : t().notes.layMap}
              shortcut="noteMap"
              onClick={() => props.onToggleMap()}
            />
            <Row
              icon={<Icon name={props.readOnly ? "lock-simple-open" : "lock-simple"} size={15} />}
              label={props.readOnly ? t().notes.makeEditable : t().notes.makeReadOnly}
              onClick={() => props.onToggleReadOnly()}
            />
            {/* Not shown for a note without examples. A row that changes nothing
                when pressed only tells the reader "it did not work" */}
            <Show when={props.hasExamples}>
              <Row
                icon={<Icon name="file-text" size={15} />}
                label={props.examplesShown ? t().notes.hideExamples : t().notes.showExamples}
                onClick={() => props.onToggleExamples()}
              />
            </Show>
            <Show when={props.kind === "note"}>
              <Row
                icon={<Icon name="book" size={15} />}
                label={t().codex.promote}
                keepOpen
                onClick={() => setConfirming(true)}
              />
            </Show>
            <Show when={props.kind === "codex"}>
              <Row
                icon={<Icon name="book-bookmark" size={15} />}
                label={t().codex.commit}
                shortcut="codexCommit"
                onClick={() => props.onCommit()}
              />
              <Row
                icon={<Icon name="clock-counter-clockwise" size={15} />}
                label={t().codex.history}
                shortcut="noteHistory"
                onClick={() => props.onHistory()}
              />
            </Show>
            {/* The clock arrow went to the history. This is the arrow that rewinds one step */}
            <Row
              icon={<Icon name="arrow-counter-clockwise" size={15} />}
              label={t().notes.revert}
              shortcut="noteRevert"
              disabled={!props.revertable}
              onClick={() => props.onRevert()}
            />
            <Row
              icon={<Icon name="info" size={15} />}
              label={t().notes.info}
              shortcut="noteInfo"
              onClick={() => props.onInfo()}
            />
            <DropdownMenu.Separator class="note-menu-divider" />
            <Row
              icon={<Icon name="trash" size={15} />}
              label={t().common.delete}
              danger
              onClick={() => props.onDelete()}
            />
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}
