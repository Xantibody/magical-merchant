import { createEffect, onCleanup } from "solid-js";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog(props: ConfirmDialogProps) {
  let dialogRef!: HTMLDialogElement;

  createEffect(() => {
    if (!dialogRef) return;

    if (props.open) {
      if (!dialogRef.open) {
        dialogRef.showModal();
      }
    } else if (dialogRef.open) {
      dialogRef.close();
    }
  });

  const handleCancel = (e: Event) => {
    e.preventDefault();
    props.onCancel();
  };

  onCleanup(() => {
    if (dialogRef?.open) {
      dialogRef.close();
    }
  });

  return (
    <dialog ref={dialogRef} class="confirm-dialog" onCancel={handleCancel}>
      <h3 class="confirm-dialog-title">{props.title}</h3>
      <p class="confirm-dialog-message">{props.message}</p>
      <div class="confirm-dialog-actions">
        <button class="btn-small" onClick={props.onCancel}>
          キャンセル
        </button>
        <button class="btn-danger" onClick={props.onConfirm}>
          削除
        </button>
      </div>
    </dialog>
  );
}
