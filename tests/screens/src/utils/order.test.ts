import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { inOrder } from "./order.ts";

describe("inOrder", () => {
  it("starts each step only once the one before has finished", async () => {
    const seen: string[] = [];
    const step = (name: string, ms: number) => async () => {
      seen.push(`${name} start`);
      await delay(ms);
      seen.push(`${name} end`);
    };
    await inOrder([step("slow", 20), step("fast", 0)]);
    expect(seen).toStrictEqual(["slow start", "slow end", "fast start", "fast end"]);
  });
});
