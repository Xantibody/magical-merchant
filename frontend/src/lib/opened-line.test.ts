import { describe, it, expect } from "vitest";
import { settleOpenedLine } from "./opened-line";

const line = { id: "a", empty: "First.\n\n<br />\n\nSecond." };

describe("settleOpenedLine", () => {
  it("saves as ever when no drop opened a line", () => {
    expect(settleOpenedLine(undefined, "a", "First.")).toStrictEqual({
      skip: false,
      line: undefined,
    });
  });

  it("skips the save while the dropped line is still empty, and keeps holding it", () => {
    expect(settleOpenedLine(line, "a", line.empty)).toStrictEqual({ skip: true, line });
  });

  it("saves the first word typed on it, and lets the line go", () => {
    expect(settleOpenedLine(line, "a", "First.\n\nA word\n\nSecond.")).toStrictEqual({
      skip: false,
      line: undefined,
    });
  });

  it("saves another note's body, whatever it reads", () => {
    expect(settleOpenedLine(line, "b", line.empty)).toStrictEqual({ skip: false, line: undefined });
  });
});
