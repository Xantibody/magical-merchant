import { describe, expect, it } from "vitest";
import { treeText } from "./tree.ts";

describe("treeText", () => {
  it("writes nothing for no node", () => {
    expect(treeText([])).toBe("");
  });

  it("writes a node as its role and quoted name", () => {
    expect(treeText([{ role: "heading", name: "Scrawl", children: [] }])).toBe(
      'heading "Scrawl"\n',
    );
  });

  it("writes a node's states after its name", () => {
    expect(
      treeText([{ role: "button", name: "Note", states: ["expanded", "pressed"], children: [] }]),
    ).toBe('button "Note" [expanded pressed]\n');
  });

  it("indents children two spaces a level and leaves out an empty name", () => {
    const tree = [
      {
        role: "main",
        name: "",
        children: [
          {
            role: "list",
            name: "",
            children: [{ role: "listitem", name: "12:00 Lunch", children: [] }],
          },
          { role: "button", name: "Jump to a date", children: [] },
        ],
      },
    ];
    expect(treeText(tree)).toBe(
      ["main", "  list", '    listitem "12:00 Lunch"', '  button "Jump to a date"', ""].join("\n"),
    );
  });
});
