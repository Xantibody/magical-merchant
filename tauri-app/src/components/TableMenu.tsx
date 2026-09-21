import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { JSX } from "solid-js";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Editor, CmdKey } from "@milkdown/kit/core";
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
import { tableMenuKey, TABLE_SELECTION_UPDATED } from "../lib/table-menu-plugin";
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
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  let live = true;
  let frame = 0;
  const place = () => {
    if (!live || !trigger) {
      return;
    }
    const view = props.editor.action((ctx) => ctx.get(editorViewCtx));
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const size = trigger.offsetWidth;
    let anchor = trigger.getBoundingClientRect();
    let x = anchor.left;
    let y = anchor.top;
    let visible = true;
    if (isInTable(view.state)) {
      const rect = selectedRect(view.state);
      const cell = view.nodeDOM(
        rect.tableStart + rect.map.map[rect.top * rect.map.width + rect.left],
      );
      if (!(cell instanceof HTMLElement)) {
        return;
      }
      const row = cell.getBoundingClientRect();
      const table = cell.closest("table")?.getBoundingClientRect();
      if (!table) {
        return;
      }
      x = Math.max(left, table.left - size);
      y = row.top + (row.height - size) / 2;
      let clipTop = top;
      let clipBottom = bottom;
      for (let parent = view.dom.parentElement; parent; parent = parent.parentElement) {
        if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(parent).overflowY)) {
          const bounds = parent.getBoundingClientRect();
          clipTop = Math.max(clipTop, bounds.top);
          clipBottom = Math.min(clipBottom, bounds.bottom);
        }
      }
      visible = y >= clipTop && y + size <= clipBottom;
      anchor = new DOMRect(x, y, size, size);
    }
    const available = Math.max(0, bottom - top - 16);
    const height = Math.min(menu?.scrollHeight ?? 320, available, (bottom - top) / 2);
    const width = menu?.offsetWidth ?? Math.min(288, right - left - 32);
    const menuX = Math.max(left + 8, Math.min(anchor.left, right - width - 8));
    const below = anchor.bottom + 4;
    const menuY = below + height <= bottom - 8 ? below : Math.max(top + 8, anchor.top - height - 4);
    setPosition({
      "--table-x": `${x}px`,
      "--table-y": `${y}px`,
      "--table-menu-x": `${menuX}px`,
      "--table-menu-y": `${menuY}px`,
      "--table-menu-height": `${height}px`,
      visibility: visible ? "visible" : "hidden",
    });
  };
  const schedulePlace = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  };
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
      schedulePlace();
    });
  onMount(() => {
    refresh();
    props.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dom.addEventListener(TABLE_SELECTION_UPDATED, refresh);
      const observer = new ResizeObserver(schedulePlace);
      observer.observe(view.dom);
      onCleanup(() => {
        observer.disconnect();
        view.dom.removeEventListener(TABLE_SELECTION_UPDATED, refresh);
      });
    });
    document.addEventListener("scroll", schedulePlace, true);
    window.addEventListener("resize", schedulePlace);
    window.visualViewport?.addEventListener("resize", schedulePlace);
    window.visualViewport?.addEventListener("scroll", schedulePlace);
  });
  onCleanup(() => {
    live = false;
    cancelAnimationFrame(frame);
    document.removeEventListener("scroll", schedulePlace, true);
    window.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("scroll", schedulePlace);
  });
  createEffect(() => {
    const active = open();
    const view = props.editor.action((ctx) => ctx.get(editorViewCtx));
    view.dispatch(view.state.tr.setMeta(tableMenuKey, active).setMeta("addToHistory", false));
    schedulePlace();
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
    <div class="editor-table-tools" classList={{ "is-contextual": inTable() }} style={position()}>
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
        <div
          ref={menu}
          class="popover editor-table-menu"
          onPointerDown={(event) => event.preventDefault()}
        >
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
