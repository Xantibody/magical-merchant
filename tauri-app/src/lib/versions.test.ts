import { describe, it, expect } from "vitest";
import { versionMessage, withDeltas } from "./versions";
import type { Version } from "./commands";

const version = (id: string, bytes: number, message: string | null = null): Version => ({
  id,
  time: "2026-09-17T14:03:00+09:00",
  message,
  bytes,
});

describe("withDeltas", () => {
  // 一覧は新しい順。差は「その版で何バイト増えたか」なので、隣は 1 つ下の行
  it("measures each version against the one before it", () => {
    const rows = withDeltas([version("c", 1500), version("b", 1200), version("a", 1300)]);

    expect(rows.map((row) => row.delta)).toStrictEqual([300, -100, 1300]);
  });

  it("is empty for a codex with no versions", () => {
    expect(withDeltas([])).toStrictEqual([]);
  });
});

describe("versionMessage", () => {
  // 「戻す前」は core がファイルに書く固定の綴り。画面ではその言語で出す
  it("translates the fixed message core writes before a restore", () => {
    expect(versionMessage(version("a", 1, "before restore"), "戻す前")).toBe("戻す前");
  });

  it("shows the author's own words untouched and nothing when there are none", () => {
    expect(versionMessage(version("a", 1, "第 3 章を足した"), "戻す前")).toBe("第 3 章を足した");
    expect(versionMessage(version("a", 1), "戻す前")).toBe("");
  });
});
