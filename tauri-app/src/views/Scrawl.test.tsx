import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useLocation } from "@solidjs/router";
import type { JSX } from "solid-js";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import Scrawl from "./Scrawl";

/**
 * The dates move. "This week" and "a year ago today" are both places counted from today,
 * so a fixed date would make a test that fails depending on the calendar.
 */
const pad = (value: number): string => String(value).padStart(2, "0");
const isoOf = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const NOW = new Date();
const TODAY = isoOf(NOW);
const YEAR_AGO = isoOf(new Date(NOW.getFullYear() - 1, NOW.getMonth(), NOW.getDate()));

/**
 * The list loads only the most recent 14 days at first. Lining up that many days that hold
 * records makes a year ago a day that is not loaded, and jumping there reloads the list.
 */
const RECENT_DATES = Array.from({ length: 14 }, (_, back) =>
  isoOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - back)),
);

/**
 * The day used to look at tag spellings. It is put 10 days back, which is loaded from the
 * start and can never fall inside "this week" (Monday based): added to today it would move
 * the week summary's count, and put a year ago it would be a day not loaded at first.
 */
const TAG_DAY = isoOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 10));

const DAYS: Record<string, string[]> = {
  [TODAY]: ["- [08:15:00] 朝ラン 5km #運動", "- [21:34:00] ベガのラッシュ止まらん #SF6"],
  [TAG_DAY]: [
    // A tag with only one spelling. Recording it in capitals later swaps the representative spelling
    "- [11:00:00] 小文字だけで書いた #run",
    // Two records writing the same tag in different case. The chips fold into one, so
    // unless the filter folds the same way one of them drops out of the list
    "- [12:30:00] 小文字で書いた #memo",
    "- [12:40:00] 大文字で書いた #Memo",
  ],
  [YEAR_AGO]: ["- [12:00:00] 去年のきょう"],
};

/** Recording rewrites it, so it is rebuilt for each test. */
let days: Record<string, string[]>;
let captureFailure: Error | undefined;

/** What `list_notes` returns. Each test starts with none. */
let notes: Record<string, unknown>[];

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_scrawl_dates: () => [...RECENT_DATES, YEAR_AGO],
  read_scrawl_by_date: ({ date }) => days[String(date)] ?? [],
  list_notes: () => notes,
  // It appends, so it becomes the newest record of that day
  save_quick_capture: ({ text }) => {
    if (captureFailure) {
      throw captureFailure;
    }
    days[TODAY]?.push(`- [22:00:00] ${String(text)}`);
  },
};

/**
 * The mouth that asks for a reload from outside the screen. It is the same `refreshData`
 * that sync and a focus return press, and the toast is read from here too.
 */
let shell: Shell;

function ShellHandle(): null {
  shell = useShell();
  return null;
}

/** The current location, used to see where pressing a chip leads. */
let location: ReturnType<typeof useLocation>;

function RouterRoot(props: { children?: JSX.Element }): JSX.Element {
  location = useLocation();
  return <>{props.children}</>;
}

/** Wait until the list arrives. The time column shows exactly one per entry. */
async function openScrawl(): Promise<void> {
  render(() => (
    <ShellProvider>
      <ShellHandle />
      <MemoryRouter root={RouterRoot}>
        <Route path="/" component={Scrawl} />
        <Route path="/browse" component={() => <p>BROWSE</p>} />
        <Route path="/notes" component={() => <p>NOTES</p>} />
      </MemoryRouter>
    </ShellProvider>
  ));
  await screen.findByText("21:34");
}

async function setupScrawl(): Promise<void> {
  await page.viewport(1280, 800);
  localStorage.clear();
  days = structuredClone(DAYS);
  notes = [];
  captureFailure = undefined;
  mockWindows("main");
  mockIPC((cmd, args) => {
    const handler = HANDLERS[cmd];
    if (!handler) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return handler((args ?? {}) as Record<string, unknown>);
  });
}

function teardownScrawl(): void {
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

describe("Scrawl capture failures", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  it("keeps the draft after a failed save and lets it be retried", async () => {
    await openScrawl();
    captureFailure = new Error("disk full");
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "書き留める" });
    fireEvent.input(input, { target: { value: "残しておきたい記録" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(shell.toast()?.message).toBe("記録を保存できませんでした。入力は残っています。"),
    );
    expect(input.value).toBe("残しておきたい記録");
    expect(days[TODAY]).toHaveLength(DAYS[TODAY].length);

    captureFailure = undefined;
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("残しておきたい記録");
    await waitFor(() => expect(input.value).toBe(""));
    expect(days[TODAY]).toHaveLength(DAYS[TODAY].length + 1);
  });
});

function lineIn(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "書き留める" });
}

describe("Scrawl › 入力行", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  it("sits at the top of today, above the day's newest record", async () => {
    await openScrawl();

    const times = [...document.querySelectorAll(`[data-day="${TODAY}"] .entry-time`)].map(
      (el) => el.textContent,
    );

    expect(times).toStrictEqual(["", "21:34", "08:15"]);
  });

  it("shows the time and the dot only once something is typed", async () => {
    await openScrawl();
    const row = lineIn().closest(".entry");
    expect(row?.classList.contains("entry--typing")).toBe(false);

    fireEvent.input(lineIn(), { target: { value: "あ" } });

    expect(row?.classList.contains("entry--typing")).toBe(true);
    expect(row?.querySelector(".entry-time")?.textContent).not.toBe("");
  });

  it("turns only the record just left green", async () => {
    await openScrawl();

    fireEvent.input(lineIn(), { target: { value: "今残した記録" } });
    fireEvent.keyDown(lineIn(), { key: "Enter" });

    const left = await screen.findByText("今残した記録");
    await waitFor(() => expect(left.closest(".entry--fresh")).not.toBeNull());
    expect(document.querySelectorAll(".entry--fresh")).toHaveLength(1);
  });

  it("keeps the line on the same element across a save", async () => {
    await openScrawl();
    const before = lineIn();

    fireEvent.input(before, { target: { value: "残す" } });
    fireEvent.keyDown(before, { key: "Enter" });
    await screen.findByText("残す");

    expect(lineIn()).toBe(before);
  });

  it("makes a Note with the line as its title on the modifier and Enter", async () => {
    let body: unknown;
    HANDLERS.create_draft = (args) => {
      ({ body } = args);
      return "/data/notes/20260903_091200.md";
    };
    await openScrawl();

    fireEvent.input(lineIn(), { target: { value: "週次の振り返り" } });
    fireEvent.keyDown(lineIn(), { key: "Enter", metaKey: true });

    await waitFor(() => expect(location.pathname).toBe("/notes"));
    expect(body).toBe("# 週次の振り返り\n\n");
    expect(location.search).toContain("edit=1");
    delete HANDLERS.create_draft;
  });

  it("gives way to the delete bar while selecting", async () => {
    await openScrawl();

    fireEvent.click(screen.getByRole("button", { name: "選択" }));

    expect(screen.queryByRole("textbox", { name: "書き留める" })).toBeNull();
    expect(screen.getByRole("toolbar")).toBeDefined();
  });
});

/** The element a record is drawn in. */
const entryOf = (text: string): Element | null => screen.getByText(text).closest(".entry");

/**
 * Every row carries icons parsed from SVG text, so a reread that rebuilt the whole page
 * would pay for 14 days of them to show one new line.
 */
describe("Scrawl › rows across a reread", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  it("keeps the rows of the other days when a capture rereads today", async () => {
    await openScrawl();
    const past = entryOf("小文字で書いた");

    fireEvent.input(lineIn(), { target: { value: "新しい記録" } });
    fireEvent.keyDown(lineIn(), { key: "Enter" });
    await screen.findByText("新しい記録");

    expect(entryOf("小文字で書いた")).toBe(past);
  });
});

describe("Scrawl › 週次ダイジェスト", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // When it was a card it listed the top tags, but the same tags already appear in the chip
  // row just above. Since that makes them read twice, the week summary folds into one line
  it("says the week in one line, with the year-ago jump as its only link", async () => {
    await openScrawl();

    const digest = screen.getByRole("region", { name: "今週" });

    expect(digest.textContent).toContain("1日で2件");
    expect(
      within(digest)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toStrictEqual(["1年前の今日の記録を見る", "今週は閉じる"]);
  });

  it("stays closed for the rest of the week", async () => {
    await openScrawl();
    expect(screen.getByRole("region", { name: "今週" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "今週は閉じる" }));

    expect(screen.queryByRole("region", { name: "今週" })).toBeNull();
  });
});

/** The hover action of the record that reads `text`. */
const promoteButtonOf = (text: string): HTMLElement => {
  const entry = screen.getByText(text).closest("article");
  if (!entry) {
    throw new Error(`no entry for ${text}`);
  }
  return within(entry).getByRole("button", { name: "Note にする" });
};

describe("Scrawl › Note にする", () => {
  beforeEach(setupScrawl);
  afterEach(() => {
    delete HANDLERS.create_draft;
    teardownScrawl();
  });

  // A stray press (or a long press meant as a scroll) must not leave a file behind and carry
  // you off the journal, so the promotion asks first, like Note -> Codex
  it("asks before making a Note from a record", async () => {
    let body: unknown;
    HANDLERS.create_draft = (args) => {
      ({ body } = args);
      return "/data/notes/20260903_091200.md";
    };
    await openScrawl();

    fireEvent.click(promoteButtonOf("朝ラン 5km"));
    const dialog = await screen.findByRole("dialog");
    expect(body).toBeUndefined();

    fireEvent.click(within(dialog).getByRole("button", { name: "Note にする" }));

    await waitFor(() => expect(location.pathname).toBe("/notes"));
    expect(body).toBe("朝ラン 5km #運動");
  });

  it("makes nothing and stays on the journal when declined", async () => {
    let made = false;
    HANDLERS.create_draft = () => {
      made = true;
      return "/data/notes/20260903_091200.md";
    };
    await openScrawl();

    fireEvent.click(promoteButtonOf("朝ラン 5km"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(made).toBe(false);
    expect(location.pathname).toBe("/");
  });
});

describe("Scrawl › Note among the rows", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  it("lists a Note among the day's records and opens it from there", async () => {
    notes = [
      {
        kind: "note",
        path: "/data/notes/20260903_091200.md",
        filename: "20260903_091200.md",
        time: `${TODAY}T09:12:00+09:00`,
        tags: [],
        preview: "Weekly review",
      },
    ];
    await openScrawl();

    fireEvent.click(await screen.findByRole("button", { name: "Weekly review" }));

    await waitFor(() => expect(location.pathname).toBe("/notes"));
    expect(location.search).toBe("?file=20260903_091200.md");
  });
});

describe("Scrawl › タグのチップ", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // The answer to a filter is not held in two places. Scrawl's list stays the records by
  // day, and narrowing is the job of search
  it("opens search with that tag instead of filtering here", async () => {
    await openScrawl();

    fireEvent.click(screen.getByRole("button", { name: "#Memo" }));

    expect(shell.searchSeed()).toStrictEqual({ tags: ["Memo"] });
    expect(location.pathname).toBe("/");
  });

  it("leaves the journal unfiltered when a chip is pressed", async () => {
    await openScrawl();

    fireEvent.click(screen.getByRole("button", { name: "#Memo" }));

    // A record without #Memo still stands under its day as before
    expect(screen.getByText("ベガのラッシュ止まらん")).toBeDefined();
  });

  // A chip shows one spelling, the one met first. Case differences fold into one
  it("names a tag with the spelling it met first", async () => {
    await openScrawl();

    const chips = screen
      .getAllByRole("button")
      .filter((button) => button.classList.contains("tag-chip"))
      .map((button) => button.textContent);

    expect(chips).toContain("#Memo");
    expect(chips).not.toContain("#memo");
  });
});

describe("Scrawl › 選択の入り口", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // No floating bar of its own is added; it sits as a word beside the count of the day being written
  it("sits beside the first day's count and nowhere else", async () => {
    await openScrawl();

    const buttons = screen.getAllByRole("button", { name: "選択" });

    expect(buttons).toHaveLength(1);
    const heading = buttons[0]?.closest("header");
    expect(heading?.textContent).toContain("今日");
    expect(heading?.textContent).toContain("2件");
  });

  // Once in, the bottom bar takes over. The same role is not shown in two places
  it("hands over to the bottom bar once selecting", async () => {
    await openScrawl();

    fireEvent.click(screen.getByRole("button", { name: "選択" }));

    expect(screen.queryByRole("button", { name: "選択" })).toBeNull();
    expect(screen.getByRole("toolbar", { name: "まとめて削除" }).textContent).toContain(
      "消すエントリを選んでください",
    );
  });
});

describe("Scrawl › 選択中の読み直し", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  /**
   * A selection points at a row by `date#index`. Leave for another app with the confirm bar
   * up, and if the automatic reload on return has added a row ahead of it on the same day,
   * the same index points at the neighbouring record. On a reload the selection is dropped:
   * after the neighbour is deleted it is too late.
   */
  it("drops the selection when the list is reloaded under it", async () => {
    await openScrawl();
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    fireEvent.click(screen.getByRole("button", { name: /朝ラン/u }));
    fireEvent.click(screen.getByRole("button", { name: "削除 (1件)" }));
    expect(screen.getByRole("toolbar", { name: "まとめて削除" }).textContent).toContain(
      "1件のエントリを削除します",
    );

    shell.refreshData();

    await waitFor(() => {
      expect(screen.queryByRole("toolbar", { name: "まとめて削除" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "選択" })).toBeDefined();
  });

  /**
   * `refreshData` is not the only thing that causes a reload. Jumping to a day not loaded
   * yet makes the resource fetch the whole list again, and if something was written from
   * outside meanwhile, the same index points at the neighbouring record. The selection is
   * dropped on the path that adds a day too.
   */
  it("drops the selection when a jump to an unloaded day reloads the list", async () => {
    await openScrawl();
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    fireEvent.click(screen.getByRole("button", { name: /朝ラン/u }));
    fireEvent.click(screen.getByRole("button", { name: "削除 (1件)" }));
    expect(screen.getByRole("toolbar", { name: "まとめて削除" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "1年前の今日の記録を見る" }));

    await waitFor(() => {
      expect(screen.queryByRole("toolbar", { name: "まとめて削除" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "選択" })).toBeDefined();
    expect(shell.toast()?.message).toBe("一覧を読み直したので選択を解除しました");
    // The day jumped to really was added (it did not stop at dropping the selection)
    await expect(screen.findByText("去年のきょう")).resolves.toBeDefined();
  });

  // Vanishing silently can only look like the delete that was pressed did not take
  it("says why the selection went away", async () => {
    await openScrawl();
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    fireEvent.click(screen.getByRole("button", { name: /朝ラン/u }));

    shell.refreshData();

    await waitFor(() => {
      expect(shell.toast()?.message).toBe("一覧を読み直したので選択を解除しました");
    });
  });

  // A reload with nothing selected is just a refetch. There is nothing to say
  it("stays quiet when nothing was selected", async () => {
    await openScrawl();

    shell.refreshData();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "選択" })).toBeDefined();
    });
    expect(shell.toast()).toBeNull();
  });
});
