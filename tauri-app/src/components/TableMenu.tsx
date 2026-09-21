import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Editor, CmdKey } from "@milkdown/kit/core";
import { listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  insertTableCommand,
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  setAlignCommand,
  exitTable,
} from "@milkdown/kit/preset/gfm";
import { deleteColumn, deleteTable, isInTable, selectedRect } from "@milkdown/kit/prose/tables";
import { closeHistory, undo, undoDepth } from "@milkdown/kit/prose/history";
import type { Command } from "@milkdown/kit/prose/state";
import { removeTableRow } from "../lib/table-commands";
import { t } from "../lib/i18n";
import Icon from "./Icon";
import Popover from "./Popover";
import "../styles/table-menu.css";

export default function TableMenu(props: { editor: Editor }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [inTable, setInTable] = createSignal(false);
  const [canInsert, setCanInsert] = createSignal(false);
  const [canRemoveRow, setCanRemoveRow] = createSignal(false);
  const [canAddBefore, setCanAddBefore] = createSignal(false);
  const [canUndo, setCanUndo] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let live = true;
  const refresh = () =>
    props.editor.action((ctx) => {
      if (!live) {
        return;
      }
      const { state } = ctx.get(editorViewCtx);
      const inside = isInTable(state);
      setInTable(inside);
      setCanRemoveRow(removeTableRow(state));
      setCanAddBefore(inside && selectedRect(state).top > 0);
      setCanUndo(undoDepth(state) > 0);
      const { $from, $to } = state.selection;
      // Never replace selected prose or turn a code fragment into a table.
      setCanInsert(
        state.selection.empty &&
          $from.sameParent($to) &&
          $from.parent.type.name === "paragraph" &&
          !inside,
      );
    });
  onMount(() => {
    refresh();
    props.editor.action((ctx) => {
      ctx.get(listenerCtx).selectionUpdated(refresh).updated(refresh);
    });
  });
  onCleanup(() => {
    live = false;
  });
  createEffect(() => {
    if (!open()) {
      return;
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      props.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    };
    document.addEventListener("keydown", escape, true);
    onCleanup(() => document.removeEventListener("keydown", escape, true));
  });
  const run = (action: () => void) => {
    const view = props.editor.action((ctx) => ctx.get(editorViewCtx));
    if (view.composing) {
      return;
    }
    view.dispatch(closeHistory(view.state.tr));
    action();
    refresh();
    setOpen(false);
    view.focus();
  };
  const command = <T,>(key: CmdKey<T>) =>
    run(() => props.editor.action((ctx) => ctx.get(commandsCtx).call(key)));
  const prose = (action: Command) =>
    run(() =>
      props.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        action(view.state, view.dispatch);
      }),
    );
  return (
    <div class="editor-table-tools">
      <button
        ref={trigger}
        type="button"
        class="icon-button editor-table-trigger"
        aria-label={t().editor.table}
        title={t().editor.table}
        aria-expanded={open()}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          refresh();
          setOpen(!open());
        }}
      >
        <Icon name="table" size={18} />
      </button>
      <Popover
        open={open()}
        onClose={() => setOpen(false)}
        trigger={() => trigger}
        label={t().editor.table}
        class="editor-table-anchor"
      >
        <div class="popover editor-table-menu" onPointerDown={(event) => event.preventDefault()}>
          <Show
            when={inTable()}
            fallback={
              <button
                type="button"
                disabled={!canInsert()}
                onClick={() => command(insertTableCommand.key)}
              >
                {t().editor.insertTable}
              </button>
            }
          >
            <button
              type="button"
              disabled={!canAddBefore()}
              onClick={() => command(addRowBeforeCommand.key)}
            >
              {t().editor.rowBefore}
            </button>
            <button type="button" onClick={() => command(addRowAfterCommand.key)}>
              {t().editor.rowAfter}
            </button>
            <button type="button" disabled={!canRemoveRow()} onClick={() => prose(removeTableRow)}>
              {t().editor.deleteRow}
            </button>
            <button type="button" onClick={() => command(addColBeforeCommand.key)}>
              {t().editor.columnBefore}
            </button>
            <button type="button" onClick={() => command(addColAfterCommand.key)}>
              {t().editor.columnAfter}
            </button>
            <button type="button" onClick={() => prose(deleteColumn)}>
              {t().editor.deleteColumn}
            </button>
            <div class="editor-table-align">
              {(["left", "center", "right"] as const).map((alignment) => (
                <button
                  type="button"
                  onClick={() =>
                    run(() =>
                      props.editor.action((ctx) =>
                        ctx.get(commandsCtx).call(setAlignCommand.key, alignment),
                      ),
                    )
                  }
                >
                  {t().editor[alignment]}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => command(exitTable.key)}>
              {t().editor.exitTable}
            </button>
            <button type="button" onClick={() => prose(deleteTable)}>
              {t().editor.deleteTable}
            </button>
          </Show>
          <button type="button" disabled={!canUndo()} onClick={() => prose(undo)}>
            {t().editor.undo}
          </button>
        </div>
      </Popover>
    </div>
  );
}
