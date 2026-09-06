import { Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import { shortcutLabel } from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";

interface NoteMenuProps {
  mapOpen: boolean;
  readOnly: boolean;
  /** この端末に「編集前の本文」が残っているか。無ければ押せない。 */
  revertable: boolean;
  onToggleMap: () => void;
  onToggleReadOnly: () => void;
  onRevert: () => void;
  onInfo: () => void;
  onDelete: () => void;
}

function Row(props: {
  icon: JSX.Element;
  label: string;
  shortcut?: ShortcutName;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      class="note-menu-row"
      classList={{ "note-menu-row--danger": props.danger }}
      disabled={props.disabled}
      onClick={() => props.onClick()}
    >
      {props.icon}
      <span class="note-menu-label">{props.label}</span>
      <Show when={props.shortcut}>
        {(name) => <span class="note-menu-key">{shortcutLabel(name())}</span>}
      </Show>
    </button>
  );
}

/**
 * ノート 1 件に効く、滅多に押さない操作をまとめた場所。
 *
 * 常時見えていたボタンをここへ畳んだのは、どれも「開いたら書く」の邪魔に
 * なる頻度でしか使われないから。よく使う人にはキーが用意してあるので、
 * この menu を開かずに済む。危険な削除だけは色で分け、いちばん下に置く。
 */
export default function NoteMenu(props: NoteMenuProps): JSX.Element {
  return (
    <div class="popover note-menu" role="menu" aria-label={t().notes.actions}>
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
      <Row
        icon={<Icon name="clock-counter-clockwise" size={15} />}
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
      <div class="note-menu-divider" />
      <Row
        icon={<Icon name="trash" size={15} />}
        label={t().common.delete}
        danger
        onClick={() => props.onDelete()}
      />
    </div>
  );
}
