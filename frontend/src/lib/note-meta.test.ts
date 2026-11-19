import { describe, it, expect } from "vitest";
import {
  addTag,
  contextRows,
  formatRecordedAt,
  resolveEditedTime,
  toDatetimeLocal,
} from "./note-meta";

describe("addTag", () => {
  it("keeps the spelling the way the body syntax does", () => {
    expect(addTag([], "#CognitiveBias")).toStrictEqual(["CognitiveBias"]);
  });

  it("drops a tag that differs only in case", () => {
    expect(addTag(["rust"], "RUST")).toStrictEqual(["rust"]);
  });

  it("appends a trimmed tag without the leading hash", () => {
    expect(addTag(["a"], " #memo ")).toStrictEqual(["a", "memo"]);
  });

  it("ignores empty input and duplicates", () => {
    expect(addTag(["a"], "  ")).toStrictEqual(["a"]);
    expect(addTag(["a"], "a")).toStrictEqual(["a"]);
  });
});

describe("formatRecordedAt", () => {
  it("shows the recorded wall-clock time", () => {
    expect(formatRecordedAt("2026-05-03T15:39:45+09:00")).toBe("2026/05/03 15:39");
  });

  it("returns an empty string for a note that was never edited", () => {
    expect(formatRecordedAt()).toBe("");
  });
});

describe("toDatetimeLocal", () => {
  it("keeps the wall-clock time as recorded", () => {
    // Like the list, show "the local time where it was written" as is. Converted
    // to the current device's time zone it would disagree with the list's time
    expect(toDatetimeLocal("2026-05-03T15:39:45+09:00")).toBe("2026-05-03T15:39");
  });
});

describe("resolveEditedTime", () => {
  it("returns the original untouched when the input did not change", () => {
    // datetime-local has no seconds. Rebuilding from the untouched value would
    // truncate the seconds just by opening and closing
    const original = "2026-05-03T15:39:45+09:00";
    expect(resolveEditedTime(original, "2026-05-03T15:39")).toBe(original);
  });

  it("keeps the original offset when the time changes", () => {
    const original = "2026-05-03T15:39:45+09:00";
    expect(resolveEditedTime(original, "2026-05-04T08:00")).toBe("2026-05-04T08:00:00+09:00");
  });

  it("keeps a UTC marker as-is", () => {
    expect(resolveEditedTime("2026-05-03T15:39:45Z", "2026-05-04T08:00")).toBe(
      "2026-05-04T08:00:00Z",
    );
  });
});

describe("contextRows", () => {
  it("lists only the fields that were recorded", () => {
    const rows = contextRows({ os: "macos", os_version: "15.3", battery: 82 });
    expect(rows).toStrictEqual([
      { label: "OS", value: "macos 15.3" },
      { label: "バッテリー", value: "82%" },
    ]);
  });

  it("marks a charging battery", () => {
    expect(contextRows({ battery: 20, is_charging: true })).toStrictEqual([
      { label: "バッテリー", value: "20% (充電中)" },
    ]);
  });

  it("renders network, hostname and location", () => {
    const rows = contextRows({
      network_type: "WiFi",
      hostname: "MacBook",
      location: { latitude: 35.67621, longitude: 139.65031 },
    });
    expect(rows).toStrictEqual([
      { label: "ネットワーク", value: "Wi-Fi" },
      { label: "ホスト名", value: "MacBook" },
      { label: "位置", value: "35.6762, 139.6503" },
    ]);
  });

  it("returns nothing for a missing context", () => {
    expect(contextRows()).toStrictEqual([]);
    expect(contextRows({})).toStrictEqual([]);
  });

  /** The writing tool is not inside the context, but to the reader it is part of the same record. */
  it("names the tool the note was written with, after the context", () => {
    expect(contextRows({ os: "macos" }, "widget")).toStrictEqual([
      { label: "OS", value: "macos" },
      { label: "書いたツール", value: "ウィジェット" },
    ]);
  });

  /** A note created before tools named themselves grows no row. */
  it("leaves the row out when the note names no tool", () => {
    expect(contextRows({ os: "macos" })).toStrictEqual([{ label: "OS", value: "macos" }]);
  });

  /** A note brought in from outside names itself on the same row. */
  it("names an imported note as imported", () => {
    expect(contextRows(undefined, "import")).toStrictEqual([
      { label: "書いたツール", value: "取り込み" },
    ]);
  });

  /** Even when the context cannot be read, the creating tool alone may be known. */
  it("shows the tool even when there is no context at all", () => {
    expect(contextRows(undefined, "cli")).toStrictEqual([{ label: "書いたツール", value: "CLI" }]);
  });
});
