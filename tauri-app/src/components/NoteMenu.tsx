import { createSignal, Show } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { NoteKind } from "../lib/commands";
import { t } from "../lib/i18n";
import { shortcutLabel } from "../lib/shortcuts";
import type { ShortcutName } from "../lib/shortcuts";

interface NoteMenuProps {
  /** 開いているか。面の側が持つ(⌘. や他のポップオーバーと排他にする)。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** どの面のノートか。Codex にできるのは Note だけ。 */
  kind: NoteKind;
  mapOpen: boolean;
  readOnly: boolean;
  /** この端末に「編集前の本文」が残っているか。無ければ押せない。 */
  revertable: boolean;
  onToggleMap: () => void;
  onToggleReadOnly: () => void;
  onRevert: () => void;
  onInfo: () => void;
  onPromote: () => void;
  /** Codex だけ。いまの下書きを版として刻む。 */
  onCommit: () => void;
  /** Codex だけ。版の一覧と差分を本文の場所に出す。 */
  onHistory: () => void;
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
 *
 * 「Codex にする」だけは Undo ではなく確認を挟む。削除と違って戻す操作が
 * 無い(Codex → Note の経路は無い)ので、押した後に取り消せない。
 */
export default function NoteMenu(props: NoteMenuProps): JSX.Element {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <>
      {/* 開く口はこの部品が持つ。「…」と中身を別の場所に置くと、外側を
          押して閉じる判断が両方の DOM を知っている誰かの仕事になる */}
      <button
        type="button"
        class="icon-button note-menu-button"
        title={t().notes.actions}
        aria-label={t().notes.actions}
        aria-expanded={props.open}
        data-key={shortcutLabel("noteActions")}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Icon name="dots-three" size={17} />
      </button>

      <Show when={props.open}>
        <div class="popover note-menu" role="menu" aria-label={t().notes.actions}>
          <Show
            when={!confirming()}
            fallback={
              <div class="note-menu-confirm">
                {/* 戻れないことより先に、何が増えるかを言う。押すかどうかは
                    それで決まる */}
                <span class="note-menu-confirm-title">
                  <Icon name="book" size={15} />
                  {t().codex.promote}
                </span>
                <p class="note-menu-confirm-label">{t().codex.promoteBody1}</p>
                <p class="note-menu-confirm-label">
                  {t().codex.promoteBody2}
                  <strong>{t().codex.promoteBody2Strong}</strong>
                </p>
                <button type="button" class="button-primary" onClick={() => props.onPromote()}>
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
            <Show when={props.kind === "note"}>
              <Row
                icon={<Icon name="book" size={15} />}
                label={t().codex.promote}
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
                onClick={() => props.onHistory()}
              />
            </Show>
            {/* 時計の矢印は履歴に譲った。こちらは 1 段だけ巻き戻す矢印 */}
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
            <div class="note-menu-divider" />
            <Row
              icon={<Icon name="trash" size={15} />}
              label={t().common.delete}
              danger
              onClick={() => props.onDelete()}
            />
          </Show>
        </div>
      </Show>
    </>
  );
}
