import { describe, it, expect } from "vitest";
import {
  addTag,
  contextRows,
  formatRecordedAt,
  resolveEditedTime,
  toDatetimeLocal,
} from "./note-meta";

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
    // 一覧と同じく「書かれた土地の時刻」をそのまま見せる。現在の端末の
    // タイムゾーンに換算すると、一覧の時刻表示と食い違う
    expect(toDatetimeLocal("2026-05-03T15:39:45+09:00")).toBe("2026-05-03T15:39");
  });
});

describe("resolveEditedTime", () => {
  it("returns the original untouched when the input did not change", () => {
    // datetime-local は秒を持たない。素通しの値から組み立て直すと、
    // 開いて閉じただけで秒が切り捨てられてしまう
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

describe("addTag", () => {
  it("appends a trimmed tag without the leading hash", () => {
    expect(addTag(["a"], " #memo ")).toEqual(["a", "memo"]);
  });

  it("ignores empty input and duplicates", () => {
    expect(addTag(["a"], "  ")).toEqual(["a"]);
    expect(addTag(["a"], "a")).toEqual(["a"]);
  });
});

describe("contextRows", () => {
  it("lists only the fields that were recorded", () => {
    const rows = contextRows({ os: "macos", os_version: "15.3", battery: 82 });
    expect(rows).toEqual([
      { label: "OS", value: "macos 15.3" },
      { label: "バッテリー", value: "82%" },
    ]);
  });

  it("marks a charging battery", () => {
    expect(contextRows({ battery: 20, is_charging: true })).toEqual([
      { label: "バッテリー", value: "20% (充電中)" },
    ]);
  });

  it("renders network, hostname and location", () => {
    const rows = contextRows({
      network_type: "WiFi",
      hostname: "MacBook",
      location: { latitude: 35.676_21, longitude: 139.650_31 },
    });
    expect(rows).toEqual([
      { label: "ネットワーク", value: "Wi-Fi" },
      { label: "ホスト名", value: "MacBook" },
      { label: "位置", value: "35.6762, 139.6503" },
    ]);
  });

  it("returns nothing for a missing context", () => {
    expect(contextRows()).toEqual([]);
    expect(contextRows({})).toEqual([]);
  });
});
