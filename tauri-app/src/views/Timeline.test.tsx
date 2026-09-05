import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route } from "@solidjs/router";
import { ShellProvider } from "../lib/shell";
import Timeline from "./Timeline";

/**
 * 日付は動く。「今週」と「1年前の今日」はどちらも今日から数えた場所なので、
 * 固定の日付を書くとカレンダー次第で落ちるテストになる。
 */
const pad = (value: number): string => String(value).padStart(2, "0");
const isoOf = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const NOW = new Date();
const TODAY = isoOf(NOW);
const YEAR_AGO = isoOf(new Date(NOW.getFullYear() - 1, NOW.getMonth(), NOW.getDate()));

const DAYS: Record<string, string[]> = {
  [TODAY]: ["- [08:15:00] 朝ラン 5km #運動", "- [21:34:00] ベガのラッシュ止まらん #SF6"],
  [YEAR_AGO]: ["- [12:00:00] 去年のきょう"],
};

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_timeline_dates: () => [TODAY, YEAR_AGO],
  read_timeline_by_date: ({ date }) => DAYS[String(date)] ?? [],
  list_notes: () => [],
};

/** 一覧が届くまで待つ。時刻の欄はエントリ 1 件につき 1 つだけ出る。 */
async function openTimeline(): Promise<void> {
  render(() => (
    <ShellProvider>
      <MemoryRouter>
        <Route path="/" component={Timeline} />
      </MemoryRouter>
    </ShellProvider>
  ));
  await screen.findByText("21:34");
}

async function setupTimeline(): Promise<void> {
  await page.viewport(1280, 800);
  localStorage.clear();
  mockWindows("main");
  mockIPC((cmd, args) => {
    const handler = HANDLERS[cmd];
    if (!handler) {
      throw new Error(`unexpected command ${cmd}`);
    }
    return handler((args ?? {}) as Record<string, unknown>);
  });
}

function teardownTimeline(): void {
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

describe("Timeline › 週次ダイジェスト", () => {
  beforeEach(setupTimeline);
  afterEach(teardownTimeline);

  // カードだった頃は上位タグを並べていたが、同じタグはすぐ上のチップ行に
  // もう出ている。二度読ませるぶん、週の要約は 1 行に畳める
  it("says the week in one line, with the year-ago jump as its only link", async () => {
    await openTimeline();

    const digest = screen.getByRole("region", { name: "今週" });

    expect(digest.textContent).toContain("1日で2件");
    expect(
      within(digest)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toStrictEqual(["1年前の今日の記録を見る", "今週は閉じる"]);
  });

  it("stays closed for the rest of the week", async () => {
    await openTimeline();
    expect(screen.getByRole("region", { name: "今週" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "今週は閉じる" }));

    expect(screen.queryByRole("region", { name: "今週" })).toBeNull();
  });
});

describe("Timeline › 選択の入り口", () => {
  beforeEach(setupTimeline);
  afterEach(teardownTimeline);

  // 浮かせた専用のバーを 1 段作らず、いま書いている日の件数の隣に字で置く
  it("sits beside the first day's count and nowhere else", async () => {
    await openTimeline();

    const buttons = screen.getAllByRole("button", { name: "選択" });

    expect(buttons).toHaveLength(1);
    const heading = buttons[0]?.closest("header");
    expect(heading?.textContent).toContain("今日");
    expect(heading?.textContent).toContain("2件");
  });

  // 入ったあとの操作は下のバーが引き受ける。同じ役目を 2 か所に出さない
  it("hands over to the bottom bar once selecting", async () => {
    await openTimeline();

    fireEvent.click(screen.getByRole("button", { name: "選択" }));

    expect(screen.queryByRole("button", { name: "選択" })).toBeNull();
    expect(screen.getByRole("toolbar", { name: "まとめて削除" }).textContent).toContain(
      "消すエントリを選んでください",
    );
  });
});
