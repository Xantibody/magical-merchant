import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { t } from "../lib/i18n";
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
                {t().common.undo}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
