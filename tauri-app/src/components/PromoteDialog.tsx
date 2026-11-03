import Dialog from "corvu/dialog";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import "../styles/promote-dialog.css";

interface PromoteDialogProps {
  open: boolean;
  icon: IconName;
  title: string;
  /** What is gained, then what it costs. A `<strong>` in it is drawn a little darker. */
  body: JSX.Element;
  yes: string;
  no: string;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * The step put before a record grows into the next surface (Scrawl -> Note, Note -> Codex).
 * Every other action is undone from a toast, but these make a new thing and move you to it.
 * It is modal: a focus that could wander back into the body would let a stray Enter decide it.
 */
export default function PromoteDialog(props: PromoteDialogProps): JSX.Element {
  const [confirm, setConfirm] = createSignal<HTMLButtonElement>();
  return (
    <Dialog
      open={props.open}
      // The press that confirms is the one offered first. The words above already said what it costs
      initialFocusEl={confirm()}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay class="promote-overlay" />
        {/* AIDEV-NOTE: the entrance animation sits on the inner box. On Dialog.Content itself corvu's presence would wait for it and never unmount */}
        <Dialog.Content class="promote-dialog-anchor">
          <div class="promote-dialog">
            <Dialog.Label class="promote-dialog-title">
              <Icon name={props.icon} size={18} />
              {props.title}
            </Dialog.Label>
            <Dialog.Description class="promote-dialog-body">{props.body}</Dialog.Description>
            <div class="promote-dialog-buttons">
              {/* corvu labels its close "close" unless told otherwise, which hides the words on it */}
              <Dialog.Close class="button-secondary" aria-label={props.no}>
                {props.no}
              </Dialog.Close>
              <button
                type="button"
                class="button-primary"
                ref={setConfirm}
                onClick={() => props.onConfirm()}
              >
                {props.yes}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
