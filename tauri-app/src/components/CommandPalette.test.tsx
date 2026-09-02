import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import CommandPalette from "./CommandPalette";
import type { SearchHit } from "../lib/commands";

const TAGGED_HIT: SearchHit = {
  kind: "timeline",
  title: "走った #sync",
  snippet: "走った #sync",
  date: "2026-09-01",
  filename: null,
  index: 0,
  tags: ["sync"],
  match_start: null,
  match_len: null,
};

function renderPalette(scopeTag: string | null) {
  const searches: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_all") {
      searches.push(args);
      return [TAGGED_HIT];
    }
    return [];
  });
  const { container } = render(() => (
    <CommandPalette commands={[]} scopeTag={scopeTag} onSelectHit={() => {}} onClose={() => {}} />
  ));
  const input = container.querySelector<HTMLInputElement>(".palette-input");
  if (!input) {
    throw new Error("palette-input not found");
  }
  return { container, input, searches };
}

describe("CommandPalette with a tag scope", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
    document.body.innerHTML = "";
  });

  // 絞った状態をそのまま眺められるのが、範囲を引き継ぐ意味
  it("lists everything under the tag before anything is typed", async () => {
    const { container, searches } = renderPalette("sync");

    expect(container.querySelector(".palette-scope")?.textContent).toContain("#sync");
    await waitFor(() => expect(searches).toContainEqual({ query: "", tags: ["sync"] }));
    await waitFor(() => expect(container.textContent).toContain("走った #sync"));
  });

  it("narrows the typed text to the tag", async () => {
    const { input, searches } = renderPalette("sync");
    fireEvent.input(input, { target: { value: "走" } });

    await waitFor(() => expect(searches).toContainEqual({ query: "走", tags: ["sync"] }));
  });

  it("drops the chip on Backspace in an empty field", () => {
    const { container, input } = renderPalette("sync");

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(container.querySelector(".palette-scope")).toBeNull();
  });

  it("drops the chip when it is clicked", () => {
    const { container } = renderPalette("sync");
    const chip = container.querySelector<HTMLButtonElement>(".palette-scope");

    chip?.click();

    expect(container.querySelector(".palette-scope")).toBeNull();
  });

  it("opens unscoped when no tag is handed over", () => {
    const { container } = renderPalette(null);

    expect(container.querySelector(".palette-scope")).toBeNull();
  });
});
