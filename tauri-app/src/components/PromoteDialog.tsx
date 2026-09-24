import Dialog from "corvu/dialog";
import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import Icon from "./Icon";
import { t } from "../lib/i18n";
import "../styles/note-panel.css";

interface PromoteDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * The one confirmation in the note's actions. Every other action is undone from a toast, but
 * a Codex has no way back to Note, so one step is put before it. It is modal: a focus that
 * could wander back into the body would let a stray Enter decide something irreversible.
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
              <Icon name="book" size={18} />
              {t().codex.promote}
            </Dialog.Label>
            {/* Say what is gained before saying there is no way back. That is what decides
                whether to press */}
            <Dialog.Description class="promote-dialog-body">
              {t().codex.promoteConfirm}
              <strong>{t().codex.promoteConfirmStrong}</strong>
              {t().codex.promoteConfirmEnd}
            </Dialog.Description>
            <div class="promote-dialog-buttons">
              <Dialog.Close class="button-secondary">{t().codex.promoteNo}</Dialog.Close>
              <button
                type="button"
                class="button-primary"
                ref={setConfirm}
                onClick={() => props.onConfirm()}
              >
                {t().codex.promoteYes}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
