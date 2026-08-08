import { describe, it, expect } from "vitest";
import { buildMonthGrid, shiftMonth, formatMonthTitle, summarizeDay } from "./calendar";
import type { DeviceContext } from "./parse-timeline";

function ctx(overrides: Partial<DeviceContext> = {}): DeviceContext {
  return { os: "", arch: "", ...overrides };
}

describe("buildMonthGrid", () => {
  it("always returns six weeks so the popover height never jumps", () => {
    expect(buildMonthGrid(2026, 7)).toHaveLength(42);
    expect(buildMonthGrid(2026, 1)).toHaveLength(42);
  });

  it("starts the week on Monday", () => {
    // 2026-08-01 is a Saturday, so the grid opens on Monday 2026-07-27
    const grid = buildMonthGrid(2026, 7);
    expect(grid[0].iso).toBe("2026-07-27");
    expect(grid[0].inMonth).toBe(false);
  });

  it("marks which cells belong to the month being shown", () => {
    const grid = buildMonthGrid(2026, 7);
    const first = grid.find((cell) => cell.iso === "2026-08-01");
    expect(first?.inMonth).toBe(true);
    expect(first?.day).toBe(1);
  });

  it("opens exactly on the first when the month starts on a Monday", () => {
    // 2026-06-01 is a Monday
    expect(buildMonthGrid(2026, 5)[0].iso).toBe("2026-06-01");
  });
});

describe("shiftMonth", () => {
  it("rolls over into the next year", () => {
    expect(shiftMonth(2026, 11, 1)).toStrictEqual([2027, 0]);
  });

  it("rolls back into the previous year", () => {
    expect(shiftMonth(2026, 0, -1)).toStrictEqual([2025, 11]);
  });
});

describe("formatMonthTitle", () => {
  it("renders a one-based month", () => {
    expect(formatMonthTitle(2026, 7)).toBe("2026年8月");
  });
});

describe("summarizeDay", () => {
  it("counts every entry, including ones with no context", () => {
    expect(summarizeDay([ctx(), null, ctx()]).count).toBe(3);
  });

  it("counts how the day got online, most used first", () => {
    const summary = summarizeDay([
      ctx({ network_type: "WiFi" }),
      ctx({ network_type: "Ethernet" }),
      ctx({ network_type: "WiFi" }),
    ]);
    expect(summary.networks).toStrictEqual([
      { label: "WiFi", count: 2 },
      { label: "Ethernet", count: 1 },
    ]);
  });

  it("leaves the networks empty when the line was never recorded", () => {
    expect(summarizeDay([ctx(), null]).networks).toStrictEqual([]);
  });

  // 緯度経度を並べても地名にはならない。数えて意味が出るのは件数のほう。
  it("counts the entries that kept their coordinates", () => {
    const summary = summarizeDay([
      ctx({ location: { latitude: 35, longitude: 139 } }),
      ctx(),
      ctx({ location: { latitude: 36, longitude: 140 } }),
    ]);
    expect(summary.located).toBe(2);
  });

  it("counts devices by os", () => {
    const summary = summarizeDay([
      ctx({ os: "macos" }),
      ctx({ os: "android" }),
      ctx({ os: "macos" }),
    ]);
    expect(summary.devices).toStrictEqual([
      { label: "macos", count: 2 },
      { label: "android", count: 1 },
    ]);
  });

  it("orders equal counts by label so the summary does not reshuffle", () => {
    const summary = summarizeDay([ctx({ os: "macos" }), ctx({ os: "android" })]);
    expect(summary.devices.map((d) => d.label)).toStrictEqual(["android", "macos"]);
  });
});
