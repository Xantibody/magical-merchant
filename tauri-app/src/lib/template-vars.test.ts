import { describe, it, expect } from "vitest";
import {
  addTemplateTag,
  formatStamp,
  hasVariable,
  resolveBody,
  resolveLine,
  splitVariables,
} from "./template-vars";

/** 2026-08-31 (Mon) 09:12:45 */
const now = new Date(2026, 7, 31, 9, 12, 45);

describe("resolveLine", () => {
  it("resolves the date to the iso day by default", () => {
    expect(resolveLine("# Daily {{date}}", now, "ja")).toBe("# Daily 2026-08-31");
  });

  it("takes a format argument", () => {
    expect(resolveLine("{{date:YYYY-MM}}", now, "ja")).toBe("2026-08");
  });

  // In `{{time:HH:mm:ss}}` only the first `:` separates the name from the format
  it("splits the name off at the first colon only", () => {
    expect(resolveLine("{{time:HH:mm:ss}}", now, "ja")).toBe("09:12:45");
  });

  it("says the weekday in the given language", () => {
    expect(resolveLine("{{weekday}}", now, "ja")).toBe("月");
    expect(resolveLine("{{weekday}}", now, "en")).toBe("Mon");
  });

  it("puts the previous note where prev is", () => {
    expect(resolveLine("前回: {{prev}}", now, "ja", "[[20260830_090000]]")).toBe(
      "前回: [[20260830_090000]]",
    );
  });

  // If a misspelled variable disappeared silently, the writer could not notice it
  it("leaves an unknown variable as written", () => {
    expect(resolveLine("{{tomorrow}}", now, "ja")).toBe("{{tomorrow}}");
  });

  it("resolves several variables on one line", () => {
    expect(resolveLine("{{date}} ({{weekday}}) {{time}}", now, "ja")).toBe("2026-08-31 (月) 09:12");
  });

  it("ignores whitespace inside the braces", () => {
    expect(resolveLine("{{ date }}", now, "ja")).toBe("2026-08-31");
  });

  it("leaves text without variables untouched", () => {
    expect(resolveLine("ただの見出し", now, "ja")).toBe("ただの見出し");
  });
});

describe("resolveBody", () => {
  it("resolves every line", () => {
    expect(resolveBody("# {{date}}\n\n## メモ\n{{time}} に書いた", now, "ja")).toBe(
      "# 2026-08-31\n\n## メモ\n09:12 に書いた",
    );
  });

  // The previous note cannot be read from here. Collapsing it to empty would leave a line
  // with only the label and no sign of what belongs there, so it is shown as written
  it("leaves the link to the previous note as written", () => {
    expect(resolveBody("上\n前回: {{prev}}\n下", now, "ja")).toBe("上\n前回: {{prev}}\n下");
  });

  it("leaves a body without variables untouched", () => {
    const body = "# 見出し\n\n- [ ] やること";
    expect(resolveBody(body, now, "ja")).toBe(body);
  });
});

describe("formatStamp", () => {
  // The pattern is a string the user wrote. Only the fixed tokens may be expanded as
  // format; everything else comes out as the characters themselves
  it("keeps everything that is not a token", () => {
    expect(formatStamp(now, "YYYY年MM月DD日")).toBe("2026年08月31日");
    expect(formatStamp(now, "100% YYYY")).toBe("100% 2026");
  });
});

describe("hasVariable", () => {
  it("tells a variable tag from a fixed one", () => {
    expect(hasVariable("{{date:YYYY-MM}}")).toBe(true);
    expect(hasVariable("daily")).toBe(false);
  });
});

describe("addTemplateTag", () => {
  it("drops the leading hash and keeps the spelling of a plain tag", () => {
    expect(addTemplateTag([], "#Daily")).toStrictEqual(["Daily"]);
  });

  // Lowercasing it would stop `YYYY` from being a token, and the tag would become the
  // literal string "yyyy-mm" instead of that month
  it("keeps a tag with a variable exactly as written", () => {
    expect(addTemplateTag([], "{{date:YYYY-MM}}")).toStrictEqual(["{{date:YYYY-MM}}"]);
  });

  it("does not add the same tag twice", () => {
    expect(addTemplateTag(["daily"], "daily")).toStrictEqual(["daily"]);
    expect(addTemplateTag(["daily"], "Daily")).toStrictEqual(["daily"]);
  });

  it("ignores an empty input", () => {
    expect(addTemplateTag(["daily"], "  ")).toStrictEqual(["daily"]);
  });
});

describe("splitVariables", () => {
  it("cuts the variables out of the surrounding text", () => {
    expect(splitVariables("# Daily {{date}} 分")).toStrictEqual([
      { text: "# Daily ", variable: false },
      { text: "{{date}}", variable: true },
      { text: " 分", variable: false },
    ]);
  });

  it("returns one plain run when there is no variable", () => {
    expect(splitVariables("本文")).toStrictEqual([{ text: "本文", variable: false }]);
  });

  it("returns nothing for an empty string", () => {
    expect(splitVariables("")).toStrictEqual([]);
  });
});
