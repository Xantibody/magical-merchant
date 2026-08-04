import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { useShell } from "../lib/shell";

export default function UndoToast(): JSX.Element {
  const shell = useShell();

  return (
    <Show when={shell.toast()}>
      {(toast) => (
        <div class="undo-toast" role="status">
          <span>{toast().message}</span>
          <Show when={toast().undo}>
            {(undo) => (
              <button
                type="button"
                class="undo-toast-action"
                onClick={() => {
                  shell.dismissToast();
                  undo()();
                }}
              >
                元に戻す
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
