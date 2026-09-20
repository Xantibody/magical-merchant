import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route, useLocation, useNavigate } from "@solidjs/router";
import type { JSX } from "solid-js";
import { ShellProvider } from "../lib/shell";
import Browse from "./Browse";

/**
 * 「今月」は今日から数えた境目なので、固定の日付を書くとカレンダー次第で
 * 落ちるテストになる。60 日前は必ず先月より前。
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

/** `browse_all` を何回呼んだか。チップを押しても増えないことを見る (#280)。 */
let scans: number;

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  browse_all: () => {
    scans += 1;
    return HITS;
  },
  read_scrawl_by_date: () => [
    '- [08:00:00] 起きた {"os":"macos"}',
    '- [08:15:00] 朝ラン 5km #run {"os":"android","os_version":"16"}',
  ],
  read_note: () => ({ body: "# レールの設計\n\nヘッダを畳んで柱にする。", revision: "r1" }),
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

/** 絞る画面を「/」に置く。ノートを開いた先は着地したことだけを言う。 */
async function openBrowse(path?: string): Promise<void> {
  render(() => (
    <ShellProvider>
      <MemoryRouter root={Root}>
        <Route path="/" component={Browse} />
        <Route path="/notes" component={() => <p>NOTES</p>} />
      </MemoryRouter>
    </ShellProvider>
  ));
  await screen.findByText("見取り図");
  if (path) {
    // 道に載った絞り込みは、着地したときに効果が読む
    navigate(path);
  }
}

/** 一覧の行。題は右の欄にも出るので、行の側だけを指して押す。 */
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

async function setup(): Promise<void> {
  await page.viewport(1280, 800);
  scans = 0;
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

  it("lists everything, newest first, with the count above it", async () => {
    await openBrowse();

    expect(rowTitles()).toStrictEqual(["朝ラン 5km #run", "レールの設計", "見取り図"]);
    expect(screen.getByText("3件")).toBeDefined();
    expect(screen.getByText("新しい順")).toBeDefined();
  });

  // 走査は Scrawl の全日ファイルと全ノートの本文を読む。開いたときの 1 回で
  // 全件が届いているので、チップを押しても数え直すだけ (#280)
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

    // Note を選んでも、選ばなかった種類の数字は「押したら何件になるか」のまま
    fireEvent.click(chip("種類", "Note"));
    expect(chipTexts("種類")).toStrictEqual(["Codex1", "Note1", "Scrawl1"]);
    expect(rowTitles()).toStrictEqual(["レールの設計"]);

    // タグの数字は種類の絞り込みを掛けた母集団から出る。並びは絞る前の
    // よく使う順で、押しても入れ替わらない
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

  // Scrawl のチップは「Scrawl とそのタグ」で画面を開く。その場では絞らない
  it("lands already narrowed when the road says so", async () => {
    await openBrowse("/?kind=scrawl&tag=run");

    await waitFor(() => {
      expect(rowTitles()).toStrictEqual(["朝ラン 5km #run"]);
    });
    // 着地したら道からは落とす。押し直した絞り込みと道が食い違わないように
    expect(location.search).toBe("");
  });
});

describe("Browse › 選んだ 1 件", () => {
  beforeEach(setup);
  afterEach(teardown);

  // 空の欄を出しておかない。選ぶ前は先頭の 1 件が出ている
  it("shows the newest hit without being asked", async () => {
    await openBrowse();

    const preview = await screen.findByRole("article");
    expect(preview.textContent).toContain("朝ラン 5km #run");
  });

  it("reads the whole body, the time and the device of the row it is given", async () => {
    await openBrowse();

    clickRow("レールの設計");

    // 題の行は本文から落とす。すぐ上に 18px で出ているので二度読ませない
    await expect(screen.findByText("ヘッダを畳んで柱にする。")).resolves.toBeDefined();
    const preview = screen.getByRole("article");
    expect(preview.textContent).toContain("2026/09/19 10:15");
    expect(preview.textContent).toContain("macos 26.0");
    expect(preview.textContent).toContain("#design");
  });

  // 1 行の記録は題がそのまま全文。下に出す本文が無いので、空の段落は置かない
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

  // Scrawl のエントリが住んでいるのはその日。行き先が 1 つしかないので、
  // 「開く」と「その日へ」を並べない
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
