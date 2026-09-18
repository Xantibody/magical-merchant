import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route } from "@solidjs/router";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
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

/**
 * 一覧が最初に載せるのは直近 14 日ぶんだけ。記録のある日をその数だけ並べると
 * 1 年前は載らない日になり、そこへ飛ぶと一覧ごと読み直される。
 */
const RECENT_DATES = Array.from({ length: 14 }, (_, back) =>
  isoOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - back)),
);

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_timeline_dates: () => [...RECENT_DATES, YEAR_AGO],
  read_timeline_by_date: ({ date }) => DAYS[String(date)] ?? [],
  list_notes: () => [],
};

/**
 * 画面の外から再読込を頼む口。同期やフォーカス復帰が押すのと同じ
 * `refreshData` で、トーストもここから読む。
 */
let shell: Shell;

function ShellHandle(): null {
  shell = useShell();
  return null;
}

/** 一覧が届くまで待つ。時刻の欄はエントリ 1 件につき 1 つだけ出る。 */
async function openTimeline(): Promise<void> {
  render(() => (
    <ShellProvider>
      <ShellHandle />
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

describe("Timeline › 選択中の読み直し", () => {
  beforeEach(setupTimeline);
  afterEach(teardownTimeline);

  /**
   * 選択は `date#index` で行を指す。確認バーを出したまま別アプリへ移り、
   * 戻ったときの自動再読込が同じ日の前へ 1 行足していると、同じ index は
   * 隣の記録を指す。読み直したら選択は畳む — 隣を消してからでは遅い。
   */
  it("drops the selection when the list is reloaded under it", async () => {
    await openTimeline();
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
   * 読み直しを起こすのは `refreshData` だけではない。まだ載っていない日へ
   * 飛ぶと、リソースは一覧ごと取り直す — そのあいだに外から書かれていれば
   * 同じ index は隣の記録を指す。日を足す経路でも選択は畳む。
   */
  it("drops the selection when a jump to an unloaded day reloads the list", async () => {
    await openTimeline();
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
    // 飛んだ先はちゃんと足されている（選択を畳むだけで終わっていない）
    await expect(screen.findByText("去年のきょう")).resolves.toBeDefined();
  });

  // 黙って消えると、押したはずの削除が効かなかったようにしか見えない
  it("says why the selection went away", async () => {
    await openTimeline();
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    fireEvent.click(screen.getByRole("button", { name: /朝ラン/u }));

    shell.refreshData();

    await waitFor(() => {
      expect(shell.toast()?.message).toBe("一覧を読み直したので選択を解除しました");
    });
  });

  // 選んでいないときの読み直しは、ただの再取得。言うことは何も無い
  it("stays quiet when nothing was selected", async () => {
    await openTimeline();

    shell.refreshData();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "選択" })).toBeDefined();
    });
    expect(shell.toast()).toBeNull();
  });
});
