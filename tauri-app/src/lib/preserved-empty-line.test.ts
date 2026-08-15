import { describe, expect, it } from "vitest";
import { isPreservedEmptyLine } from "./preserved-empty-line";

describe("isPreservedEmptyLine", () => {
  it("空行の保存に使われる <br /> 行を空行と判定する", () => {
    expect(isPreservedEmptyLine("<br />")).toBe(true);
  });

  it("揺れ(<br> <br/> <br > と前後の空白・大文字)も空行と判定する", () => {
    expect(isPreservedEmptyLine("<br>")).toBe(true);
    expect(isPreservedEmptyLine("<br/>")).toBe(true);
    expect(isPreservedEmptyLine("<br >")).toBe(true);
    expect(isPreservedEmptyLine("  <br />  ")).toBe(true);
    expect(isPreservedEmptyLine("<BR />")).toBe(true);
  });

  it("本文の一部である行は空行にしない", () => {
    expect(isPreservedEmptyLine("前 <br /> 後")).toBe(false);
    expect(isPreservedEmptyLine("<brand>")).toBe(false);
    expect(isPreservedEmptyLine("")).toBe(false);
  });
});
