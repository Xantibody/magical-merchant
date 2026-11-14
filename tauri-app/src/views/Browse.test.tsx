import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useLocation, useNavigate } from "@solidjs/router";
import type { JSX } from "solid-js";
import { loadGlyphs } from "../lib/glyphs";
import { ShellProvider } from "../lib/shell";
import Browse from "./Browse";

/**
 * "This month" is a boundary counted from today, so a fixed date makes a test
 * that fails depending on the calendar. 60 days ago is always before last month.
 */
const pad = (value: number): string => String(value).padStart(2, "0");
const isoOf = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const NOW = new Date();
const TODAY = isoOf(NOW);
const LONG_AGO = isoOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 60));

const NOTE_FILE = "20260919_101500.md";

const HITS = [
  {
    kind: "scrawl",
    title: "朝ラン 5km #run",
    snippet: "朝ラン 5km #run",
    date: TODAY,
    filename: null,
    index: 1,
    tags: ["run"],
    match_start: null,
    match_len: null,
  },
  {
    kind: "note",
    title: "レールの設計",
    snippet: "ヘッダを畳んで柱にする",
    date: TODAY,
    filename: NOTE_FILE,
    index: null,
    tags: ["design"],
    match_start: null,
    match_len: null,
  },
  {
    kind: "codex",
    title: "見取り図",
    snippet: "面は 3 つ",
    date: LONG_AGO,
    filename: "20260720_090000.md",
    index: null,
    tags: ["design", "perf"],
    match_start: null,
    match_len: null,
  },
];

/**
 * `count` records, newest first, alternating Note and Scrawl so a kind chip still leaves more
 * than a page. Titles are numbered so a row says where in the list it is.
 */
function manyHits(count: number): typeof HITS {
  return Array.from({ length: count }, (_, i) => ({
    kind: i % 2 === 0 ? "note" : "scrawl",
    title: `記録 ${i}`,
    snippet: `記録 ${i}`,
    date: TODAY,
    filename: i % 2 === 0 ? `20260101_${String(i).padStart(6, "0")}.md` : null,
    index: i % 2 === 0 ? null : i,
    tags: [],
    match_start: null,
    match_len: null,
  }));
}

/** How many times `browse_all` was called. Checks that pressing chips does not raise it (#280). */
let scans: number;
/** What `browse_all` answers. The three records above unless a test needs a long list. */
let served: typeof HITS;

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  browse_all: () => {
    scans += 1;
    return served;
  },
  read_scrawl_by_date: () => [
    '- [08:00:00] 起きた {"os":"macos"}',
    '- [08:15:00] 朝ラン 5km #run {"os":"android","os_version":"16"}',
  ],
  read_note: () => ({
    body: "# レールの設計\n\nヘッダを畳んで柱にする。\n\n## 決めたこと\n\n- **柱**は 48px\n- 詳しくは [[20260720_090000]]",
    revision: "r1",
  }),
  read_note_meta: () => ({
    time: "2026-09-19T10:15:00+09:00",
    tags: ["design"],
    context: { os: "macos", os_version: "26.0" },
  }),
};

let location: ReturnType<typeof useLocation>;
let navigate: ReturnType<typeof useNavigate>;

function Root(props: { children?: JSX.Element }): JSX.Element {
  location = useLocation();
  navigate = useNavigate();
  return <>{props.children}</>;
}

/**
 * Puts the Browse screen at "/". The note destination only says that it was reached. The box
 * bounds the height the way the app's main column does, so the list scrolls inside itself.
 */
function mountBrowse(): void {
  render(() => (
    <div style={{ display: "flex", height: "600px" }}>
      <ShellProvider>
        <MemoryRouter root={Root}>
          <Route path="/" component={Browse} />
          <Route path="/notes" component={() => <p>NOTES</p>} />
        </MemoryRouter>
      </ShellProvider>
    </div>
  ));
}

async function openBrowse(path?: string): Promise<void> {
  mountBrowse();
  await screen.findByText("見取り図");
  if (path) {
    // A filter carried on the route is read by the effect on landing
    navigate(path);
  }
}

/** Opens the screen over `count` records and waits for the first rows. */
async function openLong(count: number): Promise<void> {
  served = manyHits(count);
  mountBrowse();
  await screen.findByText("記録 0", { selector: ".browse-row-title" });
}

/**
 * Scrolls the list to `short` pixels short of its end. The list grows up from its foot, so the
 * end (the oldest records) is at the top, where a reversed column's scroll is negative.
 */
function scrollToEnd(short = 0): void {
  const list = document.querySelector(".browse-list");
  if (!list) {
    throw new Error("list not mounted");
  }
  list.scrollTop = -(list.scrollHeight - list.clientHeight - short);
}

/** A frame's wait, for seeing something not happen. `waitFor` waits until it does, so it is no use. */
function nextFrame(): Promise<number> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });
}

/** A list row. The title also appears in the right column, so only the row side is targeted. */
function clickRow(title: string): void {
  const label = [...document.querySelectorAll(".browse-row-title")].find(
    (node) => node.textContent === title,
  );
  if (!label?.parentElement) {
    throw new Error(`row ${title} not found`);
  }
  fireEvent.click(label.parentElement);
}

const group = (name: string): HTMLElement => screen.getByRole("group", { name });

const chipTexts = (name: string): string[] =>
  within(group(name))
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");

const chip = (name: string, starts: string): HTMLElement => {
  const found = within(group(name))
    .getAllByRole("button")
    .find((button) => button.textContent?.startsWith(starts));
  if (!found) {
    throw new Error(`chip ${starts} not found in ${name}`);
  }
  return found;
};

const rowTitles = (): string[] =>
  [...document.querySelectorAll(".browse-row-title")].map((node) => node.textContent ?? "");

const activeTitles = (): string[] =>
  [...document.querySelectorAll(".browse-row--active .browse-row-title")].map(
    (node) => node.textContent ?? "",
  );

async function setup(): Promise<void> {
  await page.viewport(1280, 800);
  scans = 0;
  served = HITS;
  mockWindows("main");
  mockIPC((cmd, args) => {
    const handler = HANDLERS[cmd];
    if (!handler) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return handler((args ?? {}) as Record<string, unknown>);
  });
}

function teardown(): void {
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
  globalThis.history.replaceState({}, "", "/");
}

describe("Browse › 絞り込みと件数", () => {
  beforeEach(setup);
  afterEach(teardown);

  // Drawn from the foot, so the order is said for the way it reads: the newest lowest
  it("lists everything, newest first in the markup, and says the newest is lowest", async () => {
    await openBrowse();

    expect(rowTitles()).toStrictEqual(["朝ラン 5km #run", "レールの設計", "見取り図"]);
    expect(screen.getByText("3件")).toBeDefined();
    expect(screen.getByText("下ほど新しい")).toBeDefined();
  });

  // The scan reads every Scrawl day file and every note body. The one call on
  // opening delivers everything, so pressing a chip only recounts (#280)
  it("scans once however much the chips are pressed", async () => {
    await openBrowse();
    expect(scans).toBe(1);

    fireEvent.click(chip("種類", "Note"));
    fireEvent.click(chip("タグ", "#design"));
    fireEvent.click(chip("期間", "今月"));

    expect(scans).toBe(1);
  });

  it("counts a kind over the other axes but not its own", async () => {
    await openBrowse();
    expect(chipTexts("種類")).toStrictEqual(["Codex1", "Note1", "Scrawl1"]);

    // Even with Note chosen, the unchosen kinds keep "how many if pressed" as their number
    fireEvent.click(chip("種類", "Note"));
    expect(chipTexts("種類")).toStrictEqual(["Codex1", "Note1", "Scrawl1"]);
    expect(rowTitles()).toStrictEqual(["レールの設計"]);

    // Tag numbers come from the population with the kind filter applied. The order
    // is most-used first as it was before filtering, and pressing does not reorder it
    expect(chipTexts("タグ")).toStrictEqual(["#design1", "#perf0", "#run0"]);
  });

  it("drops what falls outside the period", async () => {
    await openBrowse();

    fireEvent.click(chip("期間", "今月"));

    expect(rowTitles()).toStrictEqual(["朝ラン 5km #run", "レールの設計"]);
    expect(chipTexts("種類")).toStrictEqual(["Codex0", "Note1", "Scrawl1"]);
  });

  it("says nothing is here only once a combination really is empty", async () => {
    await openBrowse();

    fireEvent.click(chip("種類", "Scrawl"));
    fireEvent.click(chip("タグ", "#design"));

    expect(rowTitles()).toStrictEqual([]);
    expect(screen.getByText("この組み合わせの記録はありません")).toBeDefined();
  });

  it("offers the way out only while something is narrowed", async () => {
    await openBrowse();
    expect(screen.queryByRole("button", { name: "絞り込みを外す" })).toBeNull();

    fireEvent.click(chip("タグ", "#design"));
    fireEvent.click(screen.getByRole("button", { name: "絞り込みを外す" }));

    expect(rowTitles()).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "絞り込みを外す" })).toBeNull();
  });

  // A Scrawl chip opens this screen with "Scrawl and that tag". It does not filter in place
  it("lands already narrowed when the road says so", async () => {
    await openBrowse("/?kind=scrawl&tag=run");

    await waitFor(() => {
      expect(rowTitles()).toStrictEqual(["朝ラン 5km #run"]);
    });
    // Once landed, drop it from the route, so a re-pressed filter and the route cannot disagree
    expect(location.search).toBe("");
  });
});

describe("Browse › 選んだ 1 件", () => {
  beforeEach(setup);
  afterEach(teardown);

  // No empty column is left showing. Before anything is chosen, the first record is shown
  it("shows the newest hit without being asked", async () => {
    await openBrowse();

    const preview = await screen.findByRole("article");
    expect(preview.textContent).toContain("朝ラン 5km #run");
  });

  it("marks the row it shows, and only that one", async () => {
    await openBrowse();
    expect(activeTitles()).toStrictEqual(["朝ラン 5km #run"]);

    clickRow("レールの設計");

    expect(activeTitles()).toStrictEqual(["レールの設計"]);
  });

  it("reads the whole body, the time and the device of the row it is given", async () => {
    await openBrowse();

    clickRow("レールの設計");

    // The title line is dropped from the body. It is shown right above at 18px, so it is not read twice
    await expect(screen.findByText("ヘッダを畳んで柱にする。")).resolves.toBeDefined();
    const preview = screen.getByRole("article");
    expect(preview.textContent).toContain("2026/09/19 10:15");
    expect(preview.textContent).toContain("macos 26.0");
    expect(preview.textContent).toContain("#design");
  });

  // The column draws the body the way the note itself shows it read-only, not as the stored text
  it("draws the body as Markdown, the same as the note's own read-only view", async () => {
    await openBrowse();

    clickRow("レールの設計");

    const heading = await screen.findByRole("heading", { level: 2, name: "決めたこと" });
    const preview = screen.getByRole("article");
    expect(preview.contains(heading)).toBe(true);
    expect(within(preview).getAllByRole("listitem")).toHaveLength(2);
    expect(preview.querySelector("strong")?.textContent).toBe("柱");
    // A note link reads as the title it points at, as it does in the note
    expect(preview.textContent).toContain("見取り図");
    expect(preview.textContent).not.toContain("## ");
    expect(preview.textContent).not.toContain("[[");
  });

  it("opens the note a link in the body points at", async () => {
    await openBrowse();

    clickRow("レールの設計");
    const link = await screen.findByText("見取り図", { selector: "a.note-link" });
    fireEvent.click(link);

    await waitFor(() => {
      expect(location.pathname).toBe("/codex");
    });
    expect(location.search).toBe("?file=20260720_090000.md");
  });

  // For a one-line record the title is the whole text. There is no body to show below, so no empty paragraph
  it("says a one-line record has no body of its own", async () => {
    await openBrowse();

    clickRow("朝ラン 5km #run");

    await expect(screen.findByText("(本文なし — 1 行の記録)")).resolves.toBeDefined();
    expect(screen.getByRole("article").textContent).toContain("android 16");
  });

  it("opens a note at that one note", async () => {
    await openBrowse();

    clickRow("レールの設計");
    fireEvent.click(await screen.findByRole("button", { name: /開く/u }));

    await waitFor(() => {
      expect(location.pathname).toBe("/notes");
    });
    expect(location.search).toBe(`?file=${NOTE_FILE}`);
  });

  // A Scrawl entry lives in its day. There is only one destination, so "open"
  // and "to that day" are not shown side by side
  it("sends a scrawl entry to its day, and offers nothing else", async () => {
    await openBrowse();

    clickRow("朝ラン 5km #run");
    const toDay = await screen.findByRole("button", { name: /その日へ/u });
    expect(screen.queryByRole("button", { name: /開く/u })).toBeNull();

    fireEvent.click(toDay);
    await waitFor(() => {
      expect(location.search).toBe(`?day=${TODAY}`);
    });
  });
});

describe("Browse › 長い一覧", () => {
  beforeEach(setup);
  afterEach(teardown);

  // The default period is "all", so a tree of thousands of records would otherwise build
  // thousands of rows on opening, most of them never scrolled to
  it("draws the first page of a long list, and counts all of it", async () => {
    await openLong(450);

    expect(rowTitles()).toHaveLength(200);
    expect(rowTitles().at(-1)).toBe("記録 199");
    expect(screen.getByText("450件")).toBeDefined();
  });

  it("draws the next page as the end of the list comes into view", async () => {
    await openLong(450);

    scrollToEnd();

    await waitFor(() => {
      expect(rowTitles()).toHaveLength(400);
    });
    expect(rowTitles().at(-1)).toBe("記録 399");
  });

  // Drawn only once the end is in view, a flick would hit the bottom and stop there first
  it("has the next page drawn before the scroll reaches the end", async () => {
    await openLong(450);

    scrollToEnd(300);

    await waitFor(() => {
      expect(rowTitles()).toHaveLength(400);
    });
  });

  it("stops at the last record", async () => {
    await openLong(450);

    scrollToEnd();
    await waitFor(() => {
      expect(rowTitles()).toHaveLength(400);
    });
    scrollToEnd();

    await waitFor(() => {
      expect(rowTitles()).toHaveLength(450);
    });
    expect(document.querySelector(".browse-more")).toBeNull();
  });

  it("starts again from the first page when the filter changes", async () => {
    await openLong(450);
    scrollToEnd();
    await waitFor(() => {
      expect(rowTitles()).toHaveLength(400);
    });

    // 225 Notes: past one page, short of what was already drawn
    fireEvent.click(chip("種類", "Note"));
    // Long enough for the end marker to report, had the list stayed scrolled down
    await nextFrame();
    await nextFrame();

    expect(rowTitles()).toHaveLength(200);
    expect(rowTitles()[0]).toBe("記録 0");
    // The right column falls back to the first record, so the list shows it too
    expect(document.querySelector(".browse-list")?.scrollTop).toBe(0);
  });
});

describe("Browse › 狭い画面", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("has no preview column and opens on the first tap", async () => {
    await page.viewport(390, 844);
    await openBrowse();

    expect(screen.queryByRole("article")).toBeNull();

    clickRow("レールの設計");

    await waitFor(() => {
      expect(location.pathname).toBe("/notes");
    });
  });
});

describe("Browse › グリフ", () => {
  const URL_623K = "data:image/svg+xml;base64,PHN2Zy8+";
  // The newest record, so it is also the one the right column shows unasked
  const GLYPH_HIT = {
    ...HITS[0],
    title: "対空は :623k: で取る、:foo: は字のまま #fgc",
    snippet: "対空は :623k: で取る、:foo: は字のまま #fgc",
    index: 2,
    tags: ["fgc"],
  };

  beforeEach(async () => {
    await setup();
    mockIPC((cmd, args) => {
      if (cmd === "read_glyphs") {
        return [{ name: "623k", url: URL_623K }];
      }
      if (cmd === "browse_all") {
        return [GLYPH_HIT, ...HITS];
      }
      return HANDLERS[cmd]?.((args ?? {}) as Record<string, unknown>);
    });
    await loadGlyphs();
  });

  afterEach(async () => {
    // The table is the app's, not the screen's, so it outlives the render
    mockIPC(() => []);
    await loadGlyphs();
    teardown();
  });

  it("draws a registered glyph in a row's title, as Scrawl does", async () => {
    await openBrowse();

    const title = [...document.querySelectorAll(".browse-row-title")].find((node) =>
      node.textContent?.startsWith("対空は"),
    );
    expect(title?.querySelector("img.glyph")?.getAttribute("src")).toBe(URL_623K);
    // An unregistered name is not a glyph, and a row draws no tag pill: the chips on the left are the tags
    expect(title?.textContent).toBe("対空は  で取る、:foo: は字のまま #fgc");
    expect(title?.querySelector(".tag-inline")).toBeNull();
  });

  it("draws it in the heading of the record shown on the right", async () => {
    await openBrowse();

    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading.querySelector("img.glyph")?.getAttribute("src")).toBe(URL_623K);
    expect(heading.textContent).not.toContain(":623k:");
  });
});
