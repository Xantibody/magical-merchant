import Dialog from "corvu/dialog";
import type { JSX } from "solid-js";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /**
   * これを開けたボタン。押されたぶんは「外側」に数えない — 先に閉じてしまうと
   * 直後の click がもう一度開けてしまい、同じボタンでは畳めなくなる。
   */
  trigger?: () => HTMLElement | undefined;
  /** 読み上げの名前。中に見出しがあっても、器の名前は器が持つ。 */
  label: string;
  /**
   * 吊るす場所を決める入れ物の class。中の `.popover` が自分で位置を持って
   * いるなら要らない — 素の div は位置の基準を変えない。
   */
  class?: string;
  children: JSX.Element;
}

/**
 * 外側を押したら自分で閉じる、幕を張らないポップオーバーの器。
 *
 * 以前は AppLayout が 1 つの `pointerdown` で全部を閉じていて、開閉のたびに
 * 除外する class を足しにいく必要があった(足し忘れると、開いた直後に自分の
 * ボタンのぶんで畳まれる)。閉じる責任は開く場所の隣に置くほうが短い。
 *
 * corvu の Dialog を `modal={false}` で使う。幕もスクロール止めも要らず、
 * 欲しいのは「外側を押したら閉じる」1 つだけ — フォーカスは奪わない
 * (書いている手を止めない)。Escape は AppLayout が 1 箇所で受ける
 * (パレットも一緒に畳むので、ここで二重に拾わない)。
 */
export default function Popover(props: PopoverProps): JSX.Element {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
      modal={false}
      closeOnOutsidePointer
      // 押した瞬間に畳む。以前の集約もそうで、離すまで残ると「消したい物の
      // 向こうを押した」1 回が空振りになる
      closeOnOutsidePointerStrategy="pointerdown"
      closeOnEscapeKeyDown={false}
      trapFocus={false}
      onOutsidePointer={(event) => {
        const trigger = props.trigger?.();
        if (trigger && event.target instanceof Node && trigger.contains(event.target)) {
          event.preventDefault();
        }
      }}
    >
      {/* AIDEV-NOTE: ここに animation を直に書かない — corvu の presence が終わりを待ち続けて閉じなくなる。動きは中の .popover に */}
      <Dialog.Content class={props.class} aria-label={props.label}>
        {props.children}
      </Dialog.Content>
    </Dialog>
  );
}
