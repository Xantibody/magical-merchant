import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@solidjs/testing-library";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import CommandPalette from "./CommandPalette";
import type { Note, SearchHit } from "../lib/commands";

const TAGGED_HIT: SearchHit = {
  kind: "scrawl",
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

function note(filename: string, tags: string[]): Note {
  return { path: `notes/${filename}`, filename, time: "2026-09-01T09:00:00", tags, preview: "" };
}

function renderPalette(
  scopeTags: string[],
  hits: SearchHit[] = [TAGGED_HIT],
  notes: Note[] = TAGGED_NOTES,
) {
  const searches: unknown[] = [];
  const selected: SearchHit[] = [];
  mockIPC((cmd, args) => {
    if (cmd === "search_all") {
      searches.push(args);
      return hits;
    }
    if (cmd === "list_notes") {
      return notes;
    }
    return [];
  });
  const { container } = render(() => (
    <CommandPalette
      commands={[]}
      scopeTags={scopeTags}
      onSelectHit={(hit) => selected.push(hit)}
      onClose={() => {}}
    />
  ));
  const input = container.querySelector<HTMLInputElement>(".palette-input");
  if (!input) {
    throw new Error("palette-input not found");
  }
  const chips = (): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>(".palette-scope")].map(
      (chip) => chip.textContent ?? "",
    );
  const sections = (): string[] =>
    [...container.querySelectorAll(".palette-section")].map((head) => head.textContent ?? "");
  const rows = (): string[] =>
    [...container.querySelectorAll<HTMLButtonElement>(".palette-row")].map(
      (row) => row.textContent ?? "",
    );
  return { container, input, searches, selected, chips, sections, rows };
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
      expect(searches).toContainEqual({ query: "コンボ", tags: ["SF6", "ベガ"] }),
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

  // 大小だけ違う綴りで 2 行並ぶと、同じ分類が別々の件数で 2 回出る
  it("shows one home tag row for spellings that differ only in case", async () => {
    const { container } = renderPalette([], [], [note("a.md", ["Memo"]), note("b.md", ["memo"])]);

    await waitFor(() => {
      const rows = [...container.querySelectorAll<HTMLButtonElement>(".palette-row")].filter((r) =>
        r.textContent?.toLowerCase().includes("#memo"),
      );
      expect(rows.map((r) => r.textContent)).toStrictEqual(["#Memo2件"]);
    });
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

function searchHit(
  kind: SearchHit["kind"],
  title: string,
  over: Partial<SearchHit> = {},
): SearchHit {
  return {
    kind,
    title,
    snippet: title,
    date: "2026-09-01",
    filename: kind === "scrawl" ? null : "20260901_090000.md",
    index: kind === "scrawl" ? 0 : null,
    tags: [],
    match_start: null,
    match_len: null,
    ...over,
  };
}

/** 3 種類が 1 件ずつ。束ね方と、束をまたぐ上下移動を見るための並び。 */
const MIXED: SearchHit[] = [
  searchHit("note", "ベガのノート"),
  searchHit("scrawl", "ベガと走った"),
  searchHit("codex", "ベガの覚書"),
];

async function search(input: HTMLInputElement, text: string, until: () => void): Promise<void> {
  fireEvent.input(input, { target: { value: text } });
  await waitFor(until);
}

describe("CommandPalette results grouped by kind", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
    document.body.innerHTML = "";
  });

  // どこに居たものかを見出しで示す。種類の名は固有名詞なので訳さない
  it("heads each kind with its name and count, Codex first", async () => {
    const { input, sections } = renderPalette([], MIXED);

    await search(input, "ベガ", () =>
      expect(sections()).toStrictEqual(["CODEX · 1", "NOTE · 1", "SCRAWL · 1"]),
    );
  });

  it("leaves out a kind that has no hit", async () => {
    const { input, sections } = renderPalette([], [searchHit("note", "ベガのノート")]);

    await search(input, "ベガ", () => expect(sections()).toStrictEqual(["NOTE · 1"]));
  });

  // 束ねても上下移動は 1 本の並び。見出しは飛ばす
  it("moves the cursor across the groups as one list", async () => {
    const { input, container, selected, rows } = renderPalette([], MIXED);
    await search(input, "ベガ", () => expect(rows()).toHaveLength(3));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(container.querySelector(".palette-row--active")?.textContent).toContain("ベガと走った");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(selected.map((s) => s.title)).toStrictEqual(["ベガと走った"]);
  });

  // 一致語は下線(CSS)で示す。塗らないので、どこに当たったかは mark の位置だけ
  it("marks the matched word inside the title", async () => {
    const { input, container, rows } = renderPalette([], MIXED);
    await search(input, "ベガ", () => expect(rows()).toHaveLength(3));

    const marks = [...container.querySelectorAll(".palette-row-label mark")];

    expect(marks.map((mark) => mark.textContent)).toStrictEqual(["ベガ", "ベガ", "ベガ"]);
  });

  // core は大小を無視して当てる。題の側でも同じように当て、綴りは打った形でなく
  // 書いた形を残す
  it("marks the title however the word is cased", async () => {
    const { input, container, rows } = renderPalette([], [searchHit("note", "Vega のノート")]);
    await search(input, "vega", () => expect(rows()).toHaveLength(1));

    expect(container.querySelector(".palette-row-label mark")?.textContent).toBe("Vega");
  });

  it("adds the body excerpt only when the title does not carry the match", async () => {
    const hits = [
      searchHit("note", "ベガのノート", {
        snippet: "ベガのノート 続き",
        match_start: 0,
        match_len: 2,
      }),
      searchHit("note", "昨日の練習", {
        snippet: "… ベガ の下段が読めない",
        match_start: 2,
        match_len: 2,
      }),
    ];
    const { input, container, rows } = renderPalette([], hits);
    await search(input, "ベガ", () => expect(rows()).toHaveLength(2));

    const snippets = [...container.querySelectorAll(".palette-row-snippet")];

    expect(snippets.map((s) => s.textContent)).toStrictEqual(["… ベガ の下段が読めない"]);
    expect(snippets[0]?.querySelector("mark")?.textContent).toBe("ベガ");
  });

  // 足元の札。上下で選んで ↩ で開くことは、押してみるまで分からない
  it("spells the keys at the foot", () => {
    const { container } = renderPalette([], MIXED);

    const foot = [...container.querySelectorAll(".palette-footer span")];

    expect(foot.map((hint) => hint.textContent)).toStrictEqual(["↑↓ 選ぶ", "↩ 開く", "Esc 閉じる"]);
  });

  it("names the open key on the selected row alone", async () => {
    const { input, container, rows } = renderPalette([], MIXED);
    await search(input, "ベガ", () => expect(rows()).toHaveLength(3));

    const opens = [...container.querySelectorAll(".palette-row-enter")];

    expect(opens.map((open) => open.textContent)).toStrictEqual(["↩ 開く"]);
    expect(opens[0]?.closest(".palette-row")?.classList).toContain("palette-row--active");
  });

  it("counts every hit next to the input", async () => {
    const { input, container } = renderPalette([], MIXED);

    await search(input, "ベガ", () =>
      expect(container.querySelector(".palette-count")?.textContent).toBe("3 件"),
    );
  });
});
