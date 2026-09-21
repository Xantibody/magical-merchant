import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { isInTable, selectedRect } from "@milkdown/kit/prose/tables";

export const tableMenuKey = new PluginKey<boolean>("table-menu");
export const TABLE_SELECTION_UPDATED = "table-selection-updated";

export const tableMenuPlugin = $prose(
  () =>
    new Plugin({
      key: tableMenuKey,
      state: {
        init: () => false,
        apply: (tr, open) => tr.getMeta(tableMenuKey) ?? open,
      },
      // Position controls after ProseMirror has applied both state and DOM updates.
      view: () => ({
        update: (view) => view.dom.dispatchEvent(new Event(TABLE_SELECTION_UPDATED)),
      }),
      props: {
        decorations(state) {
          if (!tableMenuKey.getState(state) || !isInTable(state)) {
            return DecorationSet.empty;
          }
          const rect = selectedRect(state);
          const rows = rect.map.cellsInRect({ ...rect, left: 0, right: rect.map.width });
          const columns = rect.map.cellsInRect({ ...rect, top: 0, bottom: rect.map.height });
          const selected = new Set(rect.map.cellsInRect(rect));
          const decorations = [...new Set([...rows, ...columns])].flatMap((offset) => {
            const cell = rect.table.nodeAt(offset);
            if (!cell) {
              return [];
            }
            const from = rect.tableStart + offset;
            return [
              Decoration.node(from, from + cell.nodeSize, {
                class: selected.has(offset)
                  ? "table-menu-target table-menu-cell"
                  : "table-menu-target",
              }),
            ];
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
);
