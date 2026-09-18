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
  [YEAR_AGO]: [
    // 綴りが 1 つしかないタグ。後から大文字で記録すると代表表記が入れ替わる
    "- [11:00:00] 小文字だけで書いた #run",
    "- [12:00:00] 去年のきょう",
    // 同じタグを大小違いで書いた 2 件。チップは 1 つに畳まれるので、絞り込みも
    // 同じ畳み方でなければ片方が一覧から消える
    "- [12:30:00] 小文字で書いた #memo",
    "- [12:40:00] 大文字で書いた #Memo",
  ],
};

/** 記録すると書き換わるので、テストごとに作り直す。 */
let days: Record<string, string[]>;

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_timeline_dates: () => [TODAY, YEAR_AGO],
  read_timeline_by_date: ({ date }) => days[String(date)] ?? [],
  list_notes: () => [],
  // 追記なので、その日のいちばん新しい 1 件になる
  save_quick_capture: ({ text }) => {
    days[TODAY]?.push(`- [22:00:00] ${String(text)}`);
  },
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

/** 浮いている記録欄。Timeline が描かれた後にだけ在る。 */
function captureInput(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>(".capture-input");
  if (!input) {
    throw new Error("capture-input not found");
  }
  return input;
}

async function setupTimeline(): Promise<void> {
  await page.viewport(1280, 800);
  localStorage.clear();
  days = structuredClone(DAYS);
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

describe("Timeline › タグの絞り込み", () => {
  beforeEach(setupTimeline);
  afterEach(teardownTimeline);

  // チップに出る綴りは最初に見たものひとつで、件数はそれに畳んだ数。絞り込みが
  // 完全一致だと、代表でない綴りの記録が消えて数と一覧が食い違う
  it("keeps every spelling of the chip's tag, and the count agrees", async () => {
    await openTimeline();

    fireEvent.click(screen.getByRole("button", { name: "#Memo" }));

    expect(screen.getByText("大文字で書いた")).toBeDefined();
    expect(screen.getByText("小文字で書いた")).toBeDefined();
    expect(screen.getByText("#Memo で絞り込み中 · 2件")).toBeDefined();
  });

  // チップの綴りは「いちばん新しい 1 件の綴り」なので、絞り込み中に同じタグを
  // 大小違いで記録すると入れ替わる。選択の判定が完全一致だと、絞り込みは
  // 効いたままなのに印が消え、押しても解除できない行が残る
  it("keeps the chip selected when a newer spelling takes over, and still clears it", async () => {
    await openTimeline();
    fireEvent.click(screen.getByRole("button", { name: "#run" }));
    expect(screen.getByText("#run で絞り込み中 · 1件")).toBeDefined();

    // 末尾の空白まで打った状態にする。タグを打ちかけたままの Enter は
    // 候補の確定に取られて、送信にならない
    fireEvent.input(captureInput(), { target: { value: "きょうも走った #Run " } });
    fireEvent.keyDown(captureInput(), { key: "Enter" });

    const chip = await screen.findByRole("button", { name: "#Run" });
    expect(chip.classList.contains("tag-chip--active")).toBe(true);
    expect(screen.getByText("#Run で絞り込み中 · 2件")).toBeDefined();

    fireEvent.click(chip);

    expect(screen.queryByText(/で絞り込み中/u)).toBeNull();
    expect(screen.getByText("ベガのラッシュ止まらん")).toBeDefined();
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
