import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useLocation } from "@solidjs/router";
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import PlaceSwitch from "../components/PlaceSwitch";
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

/** The commands called, in order. This is how the number of trips to the core is counted. */
let calls: string[];

const countOf = (command: string): number => calls.filter((cmd) => cmd === command).length;

const DATES = [...RECENT_DATES, YEAR_AGO];

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  // A capture rereads only the day it wrote to
  read_scrawl_by_date: ({ date }) => days[String(date)] ?? [],
  // The same pick as core: the newest `recent` days and the ones named, newest first, once each
  read_scrawl_days: ({ recent, extra }) => {
    const wanted = [...new Set([...DATES.slice(0, Number(recent)), ...(extra as string[])])];
    return {
      dates: DATES,
      days: wanted
        .toSorted((a, b) => b.localeCompare(a))
        .map((date) => ({ date, entries: days[date] ?? [] })),
    };
  },
  list_notes: () => notes,
  // It appends, so it becomes the newest record of that day
  save_quick_capture: ({ text }) => {
    if (captureFailure) {
      throw captureFailure;
    }
    days[TODAY]?.push(`- [22:00:00] ${String(text)}`);
  },
  // The same guard as core: an index that no longer holds the line the screen read is refused
  delete_scrawl_entry: ({ date, index, raw }) => {
    const lines = days[String(date)] ?? [];
    if (lines[Number(index)] !== raw) {
      throw new Error(`Stale: scrawl entry ${String(index)}`);
    }
    lines.splice(Number(index), 1);
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

/** The shell's place pill, as AppLayout mounts it on a phone; Scrawl's field goes into its slot. */
function PhonePill(props: { children?: JSX.Element }): JSX.Element {
  location = useLocation();
  const pillShell = useShell();
  return (
    <>
      {props.children}
      <Show when={!pillShell.placesAway()}>
        <PlaceSwitch stretched slot={pillShell.setPlacesSlot} />
      </Show>
    </>
  );
}

/** Wait until the list arrives. The time column shows exactly one per entry. */
async function openScrawl(phone = false): Promise<void> {
  render(() => (
    <ShellProvider>
      <ShellHandle />
      <MemoryRouter root={phone ? PhonePill : RouterRoot}>
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
  calls = [];
  mockWindows("main");
  mockIPC((cmd, args) => {
    calls.push(cmd);
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

describe("Scrawl › 読み込み", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // It is the first screen. A trip per day, each run on the main thread, held the window
  // for every one of them before anything could be typed
  it("reads the dates and the visible days in one call", async () => {
    await openScrawl();

    expect(countOf("read_scrawl_days")).toBe(1);
    expect(countOf("list_scrawl_dates")).toBe(0);
    expect(countOf("read_scrawl_by_date")).toBe(0);
  });

  // dataVersion rises on every return to the window, and the journal is reread each time
  it("rereads them in one call when the data changes", async () => {
    await openScrawl();

    shell.refreshData();

    await waitFor(() => expect(countOf("read_scrawl_days")).toBe(2));
    expect(countOf("read_scrawl_by_date")).toBe(0);
  });
});

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

  // The field ends the sheet, under the days: it stays where the hand is while the list above
  // reads newest first
  it("stands at the foot of the sheet, after the days, on a wide window", async () => {
    await openScrawl();
    const today = document.querySelector(`[data-day="${TODAY}"]`);

    expect(lineIn().closest(".scrawl-composer")).not.toBeNull();
    expect(
      Boolean(lineIn().compareDocumentPosition(today as Node) & Node.DOCUMENT_POSITION_PRECEDING),
    ).toBe(true);
  });

  // A feed, not a conversation: the newest line of the day is the first one read
  it("runs a day's lines newest first", async () => {
    await openScrawl();
    const times = [...document.querySelectorAll(`[data-day="${TODAY}"] .entry-time`)].map(
      (el) => el.textContent,
    );

    expect(times.length).toBeGreaterThan(1);
    expect(times).toStrictEqual(times.toSorted().toReversed());
  });

  // Today is the first day on the page, the older ones below it
  it("runs the days newest first", async () => {
    await openScrawl();
    const order = [...document.querySelectorAll<HTMLElement>("[data-day]")].map(
      (el) => el.dataset.day,
    );

    expect(order.length).toBeGreaterThan(1);
    expect(order[0]).toBe(TODAY);
    expect(order).toStrictEqual(order.toSorted().toReversed());
  });

  // A phone writes in the shell's place pill, stretched: one thing at the foot, not a bar
  it("carries the field into the place pill beside the places on a phone", async () => {
    await page.viewport(390, 844);
    await openScrawl(true);

    const pill = lineIn().closest(".place-switch");

    expect(pill).not.toBeNull();
    expect(pill?.querySelector("nav.place-switch-places")).not.toBeNull();
    expect(lineIn().closest(".scrawl")).toBeNull();
    // No round button and sheet on top of it: one floating pill, not two
    expect(document.querySelector(".compose-fab")).toBeNull();
  });

  // The field lives in the pill but is still this screen's: a send keeps the same element
  it("keeps the line in the pill across a save on a phone", async () => {
    await page.viewport(390, 844);
    await openScrawl(true);
    const before = lineIn();

    fireEvent.input(before, { target: { value: "ピルから残す" } });
    fireEvent.keyDown(before, { key: "Enter" });
    await screen.findByText("ピルから残す");

    expect(lineIn()).toBe(before);
    await waitFor(() => expect(before.value).toBe(""));
  });

  // The select bar stands where the pill floats, so the pill steps away until it is done
  it("sends the pill away while selecting on a phone", async () => {
    await page.viewport(390, 844);
    await openScrawl(true);

    fireEvent.click(screen.getByRole("button", { name: "選択" }));

    expect(shell.placesAway()).toBe(true);
    expect(document.querySelector(".place-switch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(shell.placesAway()).toBe(false);
    expect(lineIn().closest(".place-switch")).not.toBeNull();
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

  it("keeps today's earlier records when a capture rereads today", async () => {
    await openScrawl();
    const earlier = entryOf("ベガのラッシュ止まらん");

    fireEvent.input(lineIn(), { target: { value: "新しい記録" } });
    fireEvent.keyDown(lineIn(), { key: "Enter" });
    await screen.findByText("新しい記録");

    expect(entryOf("ベガのラッシュ止まらん")).toBe(earlier);
  });

  // A focus return or a sync rereads every day, and usually brings nothing new
  it("keeps every row a full reread did not change", async () => {
    await openScrawl();
    const today = entryOf("ベガのラッシュ止まらん");
    const past = entryOf("小文字で書いた");

    days[TAG_DAY]?.push("- [13:00:00] 同期で届いた記録");
    shell.refreshData();
    await screen.findByText("同期で届いた記録");

    expect(entryOf("ベガのラッシュ止まらん")).toBe(today);
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

  it("stays on the journal and says so when the Note cannot be made", async () => {
    HANDLERS.create_draft = () => {
      throw new Error("disk full");
    };
    await openScrawl();

    fireEvent.click(promoteButtonOf("朝ラン 5km"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Note にする" }));

    await waitFor(() => expect(shell.toast()?.message).toBe("Note を作れませんでした"));
    expect(location.pathname).toBe("/");
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

/** A Note promoted from this morning's run. Its chip sits under that record. */
const PROMOTED = {
  kind: "note",
  path: "/data/notes/20260903_091200.md",
  filename: "20260903_091200.md",
  time: `${TODAY}T09:12:00+09:00`,
  tags: [],
  preview: "Weekly review",
  origin: `${TODAY}T08:15:00`,
};

describe("Scrawl › Note との関係の解除", () => {
  beforeEach(setupScrawl);
  afterEach(() => {
    delete HANDLERS.set_note_origin;
    teardownScrawl();
  });

  it("keeps the chip and says so when the unlink is refused", async () => {
    notes = [PROMOTED];
    HANDLERS.set_note_origin = () => {
      throw new Error("disk full");
    };
    await openScrawl();

    fireEvent.click(await screen.findByRole("button", { name: "「Weekly review」との関係を解除" }));

    await waitFor(() => expect(shell.toast()?.message).toBe("Note との関係を解除できませんでした"));
    // Nothing offers an undo of an unlink that did not happen
    expect(shell.toast()?.undo).toBeUndefined();
    expect(screen.getByRole("button", { name: "Weekly review" })).toBeDefined();
  });

  // The undo is a write of its own. When it is refused the chip stays away, and only words say why
  it("says so when the undo cannot link the Note back", async () => {
    notes = [PROMOTED];
    HANDLERS.set_note_origin = () => {
      notes = [{ ...PROMOTED, origin: undefined }];
    };
    await openScrawl();
    fireEvent.click(await screen.findByRole("button", { name: "「Weekly review」との関係を解除" }));
    await waitFor(() => expect(shell.toast()?.undo).toBeInstanceOf(Function));
    // The disk starts refusing between the unlink and its undo
    HANDLERS.set_note_origin = () => {
      throw new Error("disk full");
    };

    shell.toast()?.undo?.();

    await waitFor(() => expect(shell.toast()?.message).toBe("Note との関係を戻せませんでした"));
  });
});

/** The time a press has to last, and a little over: the fill is drawn from real time. */
function held(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Holds a held-to-confirm button down until it has gone through (96). */
async function holdDown(button: HTMLElement): Promise<void> {
  button.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
  await held(950);
  button.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", bubbles: true }));
}

/** Selects the records that read these words, then holds delete down until it goes. */
async function deleteSelected(...words: string[]): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "選択" }));
  for (const word of words) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(word, "u") }));
  }
  await holdDown(
    screen.getByRole("button", { name: new RegExp(`^削除 \\(${words.length}件\\)`, "u") }),
  );
}

describe("Scrawl › 最新へ", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // S6: once the newest are out of sight, one press brings them back to the top
  it("offers the way back once scrolled away, and goes there", async () => {
    await openScrawl();
    // No stylesheet here: the scroll area is given its scrolling by hand, a short one
    const scroll = document.querySelector(".scrawl-scroll") as HTMLElement;
    scroll.style.overflowY = "auto";
    scroll.style.height = "100px";
    expect(screen.queryByRole("button", { name: "最新へ" })).toBeNull();

    scroll.scrollTop = 200;
    expect(scroll.scrollTop).toBe(200);
    fireEvent.scroll(scroll);
    fireEvent.click(await screen.findByRole("button", { name: "最新へ" }));

    await expect.poll(() => scroll.scrollTop).toBe(0);
    fireEvent.scroll(scroll);
    await waitFor(() => expect(screen.queryByRole("button", { name: "最新へ" })).toBeNull());
  });
});

describe("Scrawl › 記録を開く", () => {
  beforeEach(setupScrawl);
  afterEach(() => {
    vi.restoreAllMocks();
    teardownScrawl();
  });

  it("opens one record at a time", async () => {
    await openScrawl();

    fireEvent.click(screen.getByText("朝ラン 5km"));
    fireEvent.click(screen.getByText("ベガのラッシュ止まらん"));

    const toolbars = screen.getAllByRole("toolbar", { name: "この記録の操作" });
    expect(toolbars).toHaveLength(1);
    expect(entryOf("ベガのラッシュ止まらん")?.contains(toolbars[0])).toBe(true);
  });

  it("copies the record's text as written", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await openScrawl();
    fireEvent.click(screen.getByText("朝ラン 5km"));

    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "コピー" }));

    await waitFor(() => expect(shell.toast()?.message).toBe("コピーしました"));
    expect(write).toHaveBeenCalledWith("朝ラン 5km #運動");
  });

  // The select bar's path: one line at a time, against the line the screen read
  it("deletes the one record once its delete has been held", async () => {
    await openScrawl();
    fireEvent.click(screen.getByText("朝ラン 5km"));
    const toolbar = screen.getByRole("toolbar");

    await holdDown(within(toolbar).getByRole("button", { name: /^削除 \(/u }));

    await waitFor(() => expect(shell.toast()?.message).toBe("1件のエントリを削除しました"));
    expect(days[TODAY]).toStrictEqual(["- [21:34:00] ベガのラッシュ止まらん #SF6"]);
    expect(screen.queryByText("朝ラン 5km")).toBeNull();
  });
});

describe("Scrawl › まとめて削除", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  it("deletes the chosen records and says how many", async () => {
    await openScrawl();

    await deleteSelected("朝ラン", "ベガ");

    await waitFor(() => expect(shell.toast()?.message).toBe("2件のエントリを削除しました"));
    expect(days[TODAY]).toStrictEqual([]);
    expect(screen.queryByText("ベガのラッシュ止まらん")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "まとめて削除" })).toBeNull();
  });

  /**
   * The lines go one at a time, newest first. A line rewritten elsewhere after the screen read
   * it is refused midway (Stale). The line already deleted has to leave the screen, the
   * rewritten one shows as it is now, and the selection goes: its indices have shifted.
   */
  it("rereads the day, drops the selection and says how many were left when one is refused", async () => {
    await openScrawl();
    // Rewritten from another device after the screen read it. Index 0 goes second
    days[TODAY] = ["- [08:15:00] 別の端末で書き換えた", "- [21:34:00] ベガのラッシュ止まらん #SF6"];

    await deleteSelected("朝ラン", "ベガ");

    await waitFor(() => expect(shell.toast()?.message).toBe("1件のエントリを削除できませんでした"));
    expect(days[TODAY]).toStrictEqual(["- [08:15:00] 別の端末で書き換えた"]);
    await expect(screen.findByText("別の端末で書き換えた")).resolves.toBeDefined();
    expect(screen.queryByText("ベガのラッシュ止まらん")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "まとめて削除" })).toBeNull();
    expect(screen.getByRole("button", { name: "選択" })).toBeDefined();
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
   * A selection points at a row by `date#index`. Leave for another app with records
   * selected, and if the automatic reload on return has added a row ahead of it on the same
   * day, the same index points at the neighbouring record. On a reload the selection is
   * dropped: after the neighbour is deleted it is too late.
   */
  it("drops the selection when the list is reloaded under it", async () => {
    await openScrawl();
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    fireEvent.click(screen.getByRole("button", { name: /朝ラン/u }));
    expect(screen.getByRole("toolbar", { name: "まとめて削除" }).textContent).toContain(
      "1件選択中",
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
