import type { Command } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import { closeHistory } from "@milkdown/kit/prose/history";
import { deleteRow, goToNextCell, isInTable, selectedRect } from "@milkdown/kit/prose/tables";

// Markdown needs a header and at least one body row in the GFM schema.
export const removeTableRow: Command = (state, dispatch) => {
  if (!isInTable(state)) {
    return false;
  }
  const rect = selectedRect(state);
  if (rect.top === 0 || rect.bottom - rect.top >= rect.map.height - 1) {
    return false;
  }
  return deleteRow(state, dispatch);
};

// Append and move in one transaction so Undo removes exactly the new row.
export const nextTableCell: Command = (state, dispatch) => {
  if (goToNextCell(1)(state, dispatch)) {
    return true;
  }
  if (!isInTable(state) || !state.selection.empty) {
    return false;
  }
  const { table, tableStart } = selectedRect(state);
  const cells = [];
  for (let col = 0; col < table.child(0).childCount; col++) {
    cells.push(
      state.schema.nodes.table_cell.create(
        {
          alignment: table.child(0).child(col).attrs.alignment,
        },
        state.schema.nodes.paragraph.create(),
      ),
    );
  }
  const pos = tableStart + table.content.size;
  const tr = closeHistory(state.tr).insert(pos, state.schema.nodes.table_row.create(null, cells));
  tr.setSelection(TextSelection.create(tr.doc, pos + 3));
  dispatch?.(tr.scrollIntoView());
  return true;
};
