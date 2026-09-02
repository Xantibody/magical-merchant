import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import CommandPalette from "./CommandPalette";
import type { Note, SearchHit } from "../lib/commands";

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

/** zero-query の入り口にタグ行を出すためのノート。 */
const TAGGED_NOTES: Note[] = [
  {
    path: "notes/20260901_090000.md",
    filename: "20260901_090000.md",
    time: "2026-09-01T09:00:00",
    tags: ["sf6", "ベガ"],
    preview: "ベガ対策",
  },
];

function renderPalette(scopeTags: string[], hits: SearchHit[] = [TAGGED_HIT]) {
  const searches: unknown[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_all") {
      searches.push(args);
      return hits;
    }
    if (cmd === "list_notes") {
      return TAGGED_NOTES;
    }
    return [];
  });
  const { container } = render(() => (
    <CommandPalette commands={[]} scopeTags={scopeTags} onSelectHit={() => {}} onClose={() => {}} />
  ));
  const input = container.querySelector<HTMLInputElement>(".palette-input");
  if (!input) {
    throw new Error("palette-input not found");
  }
  const chips = (): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>(".palette-scope")].map(
      (chip) => chip.textContent ?? "",
    );
  return { container, input, searches, chips };
}

describe("CommandPalette with a tag scope", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
    document.body.innerHTML = "";
  });

  // 絞った状態をそのまま眺められるのが、範囲を引き継ぐ意味
  it("lists everything under the tag before anything is typed", async () => {
    const { container, chips, searches } = renderPalette(["sync"]);

    expect(chips()).toStrictEqual(["#sync"]);
    await waitFor(() => expect(searches).toContainEqual({ query: "", tags: ["sync"] }));
    await waitFor(() => expect(container.textContent).toContain("走った #sync"));
  });

  it("narrows the typed text to the tag", async () => {
    const { input, searches } = renderPalette(["sync"]);
    fireEvent.input(input, { target: { value: "走" } });

    await waitFor(() => expect(searches).toContainEqual({ query: "走", tags: ["sync"] }));
  });

  it("shows one chip per tag and requires all of them", async () => {
    const { chips, searches } = renderPalette(["sf6", "ベガ"]);

    expect(chips()).toStrictEqual(["#sf6", "#ベガ"]);
    await waitFor(() => expect(searches).toContainEqual({ query: "", tags: ["sf6", "ベガ"] }));
  });

  // 打った `#タグ` はチップにならず、そのまま範囲として効く
  it("sends typed hashtags as scope, not as query text", async () => {
    const { input, chips, searches } = renderPalette([]);
    fireEvent.input(input, { target: { value: "#SF6 #ベガ コンボ" } });

    await waitFor(() =>
      expect(searches).toContainEqual({ query: "コンボ", tags: ["sf6", "ベガ"] }),
    );
    expect(chips()).toStrictEqual([]);
  });

  it("adds typed hashtags to the chips", async () => {
    const { input, searches } = renderPalette(["sf6"]);
    fireEvent.input(input, { target: { value: "#ベガ" } });

    await waitFor(() => expect(searches).toContainEqual({ query: "", tags: ["sf6", "ベガ"] }));
  });

  it("drops only the last chip on Backspace in an empty field", () => {
    const { input, chips } = renderPalette(["sf6", "ベガ"]);

    fireEvent.keyDown(input, { key: "Backspace" });

    expect(chips()).toStrictEqual(["#sf6"]);
  });

  it("drops the chip that is clicked", () => {
    const { container, chips } = renderPalette(["sf6", "ベガ"]);
    const first = container.querySelector<HTMLButtonElement>(".palette-scope");

    first?.click();

    expect(chips()).toStrictEqual(["#ベガ"]);
  });

  // 入り口のタグ行は文字を貼らず、チップとして範囲に足す
  it("turns a home tag row into a chip", async () => {
    const { container, chips, searches } = renderPalette([]);
    let row: HTMLButtonElement | undefined;
    await waitFor(() => {
      row = [...container.querySelectorAll<HTMLButtonElement>(".palette-row")].find((r) =>
        r.textContent?.includes("#sf6"),
      );
      expect(row).toBeDefined();
    });

    row?.click();

    expect(chips()).toStrictEqual(["#sf6"]);
    await waitFor(() => expect(searches).toContainEqual({ query: "", tags: ["sf6"] }));
  });

  it("names every tag in the empty message", async () => {
    const { container } = renderPalette(["sf6", "ベガ"], []);

    await waitFor(() =>
      expect(container.querySelector(".palette-empty")?.textContent).toContain("#sf6 #ベガ"),
    );
  });

  it("opens unscoped when no tag is handed over", () => {
    const { chips } = renderPalette([]);

    expect(chips()).toStrictEqual([]);
  });
});
