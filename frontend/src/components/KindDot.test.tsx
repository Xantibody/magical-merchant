import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import KindDot from "./KindDot";

function isFilled(kind: "scrawl" | "note" | "codex"): boolean {
  const { container } = render(() => <KindDot kind={kind} />);
  return container.querySelector(".kind-dot")?.classList.contains("kind-dot--filled") ?? false;
}

describe("KindDot", () => {
  it("is hollow for a line of Scrawl", () => {
    expect(isFilled("scrawl")).toBe(false);
  });

  it.each(["note", "codex"] as const)("is filled for a %s", (kind) => {
    expect(isFilled(kind)).toBe(true);
  });
});
