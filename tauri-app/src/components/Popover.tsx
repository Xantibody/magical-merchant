import Dialog from "corvu/dialog";
import type { JSX } from "solid-js";

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /**
   * The button that opened this. A press on it does not count as "outside":
   * closing first would let the click right after reopen it, and the same
   * button could never fold it.
   */
  trigger?: () => HTMLElement | undefined;
  /** The name for a screen reader. Even with a heading inside, the container names itself. */
  label: string;
  /**
   * Class of the container that decides where it hangs. Not needed when the
   * `.popover` inside positions itself: a plain div does not change the
   * positioning reference.
   */
  class?: string;
  children: JSX.Element;
}

/**
 * A popover container without a backdrop that closes itself on an outside press.
 *
 * AppLayout used to close everything from one `pointerdown`, and every new
 * popover meant adding a class to its exclusion list (forget it, and the popover
 * folds right after opening from its own button's press). Putting the closing
 * responsibility next to the opening place is shorter.
 *
 * corvu's Dialog is used with `modal={false}`. No backdrop, no scroll lock; the
 * one thing wanted is "close on an outside press". It does not take focus (it
 * does not stop a writing hand). Escape is handled by AppLayout in one place
 * (it folds the palette too, so it is not caught twice here).
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
      // Fold on the press itself. The old central handler did the same; staying
      // until release makes the one press "through the thing to dismiss" a miss
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
      {/* AIDEV-NOTE: Do not put an animation directly here: corvu's presence keeps waiting for it to end and never closes. Motion goes on the .popover inside */}
      <Dialog.Content class={props.class} aria-label={props.label}>
        {props.children}
      </Dialog.Content>
    </Dialog>
  );
}
