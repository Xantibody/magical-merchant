import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@solidjs/testing-library";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { page } from "vitest/browser";
import { MemoryRouter, Route } from "@solidjs/router";
import { ShellProvider, useShell } from "../lib/shell";
import type { Shell } from "../lib/shell";
import Scrawl from "./Scrawl";

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

/**
 * 一覧が最初に載せるのは直近 14 日ぶんだけ。記録のある日をその数だけ並べると
 * 1 年前は載らない日になり、そこへ飛ぶと一覧ごと読み直される。
 */
const RECENT_DATES = Array.from({ length: 14 }, (_, back) =>
  isoOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - back)),
);

/**
 * タグの綴りを見るための日。最初から載っていて、かつ「今週」(月曜起点)には
 * 決して入らない 10 日前に置く — 今日へ足すと週の要約の件数が動き、1 年前へ
 * 置くと最初は載らない日になってしまう。
 */
const TAG_DAY = isoOf(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 10));

const DAYS: Record<string, string[]> = {
  [TODAY]: ["- [08:15:00] 朝ラン 5km #運動", "- [21:34:00] ベガのラッシュ止まらん #SF6"],
  [TAG_DAY]: [
    // 綴りが 1 つしかないタグ。後から大文字で記録すると代表表記が入れ替わる
    "- [11:00:00] 小文字だけで書いた #run",
    // 同じタグを大小違いで書いた 2 件。チップは 1 つに畳まれるので、絞り込みも
    // 同じ畳み方でなければ片方が一覧から消える
    "- [12:30:00] 小文字で書いた #memo",
    "- [12:40:00] 大文字で書いた #Memo",
  ],
  [YEAR_AGO]: ["- [12:00:00] 去年のきょう"],
};

/** 記録すると書き換わるので、テストごとに作り直す。 */
let days: Record<string, string[]>;

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  list_scrawl_dates: () => [...RECENT_DATES, YEAR_AGO],
  read_scrawl_by_date: ({ date }) => days[String(date)] ?? [],
  list_notes: () => [],
  // 追記なので、その日のいちばん新しい 1 件になる
  save_quick_capture: ({ text }) => {
    days[TODAY]?.push(`- [22:00:00] ${String(text)}`);
  },
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
async function openScrawl(): Promise<void> {
  render(() => (
    <ShellProvider>
      <ShellHandle />
      <MemoryRouter>
        <Route path="/" component={Scrawl} />
      </MemoryRouter>
    </ShellProvider>
  ));
  await screen.findByText("21:34");
}

/** 浮いている記録欄。Scrawl が描かれた後にだけ在る。 */
function captureInput(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>(".capture-input");
  if (!input) {
    throw new Error("capture-input not found");
  }
  return input;
}

async function setupScrawl(): Promise<void> {
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

function teardownScrawl(): void {
  cleanup();
  clearMocks();
  document.body.innerHTML = "";
}

describe("Scrawl › 週次ダイジェスト", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // カードだった頃は上位タグを並べていたが、同じタグはすぐ上のチップ行に
  // もう出ている。二度読ませるぶん、週の要約は 1 行に畳める
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

describe("Scrawl › タグの絞り込み", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // チップに出る綴りは最初に見たものひとつで、件数はそれに畳んだ数。絞り込みが
  // 完全一致だと、代表でない綴りの記録が消えて数と一覧が食い違う
  it("keeps every spelling of the chip's tag, and the count agrees", async () => {
    await openScrawl();

    fireEvent.click(screen.getByRole("button", { name: "#Memo" }));

    expect(screen.getByText("大文字で書いた")).toBeDefined();
    expect(screen.getByText("小文字で書いた")).toBeDefined();
    expect(screen.getByText("#Memo で絞り込み中 · 2件")).toBeDefined();
  });

  // チップの綴りは「いちばん新しい 1 件の綴り」なので、絞り込み中に同じタグを
  // 大小違いで記録すると入れ替わる。選択の判定が完全一致だと、絞り込みは
  // 効いたままなのに印が消え、押しても解除できない行が残る
  it("keeps the chip selected when a newer spelling takes over, and still clears it", async () => {
    await openScrawl();
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

describe("Scrawl › 選択の入り口", () => {
  beforeEach(setupScrawl);
  afterEach(teardownScrawl);

  // 浮かせた専用のバーを 1 段作らず、いま書いている日の件数の隣に字で置く
  it("sits beside the first day's count and nowhere else", async () => {
    await openScrawl();

    const buttons = screen.getAllByRole("button", { name: "選択" });

    expect(buttons).toHaveLength(1);
    const heading = buttons[0]?.closest("header");
    expect(heading?.textContent).toContain("今日");
    expect(heading?.textContent).toContain("2件");
  });

  // 入ったあとの操作は下のバーが引き受ける。同じ役目を 2 か所に出さない
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
   * 選択は `date#index` で行を指す。確認バーを出したまま別アプリへ移り、
   * 戻ったときの自動再読込が同じ日の前へ 1 行足していると、同じ index は
   * 隣の記録を指す。読み直したら選択は畳む — 隣を消してからでは遅い。
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
   * 読み直しを起こすのは `refreshData` だけではない。まだ載っていない日へ
   * 飛ぶと、リソースは一覧ごと取り直す — そのあいだに外から書かれていれば
   * 同じ index は隣の記録を指す。日を足す経路でも選択は畳む。
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
    // 飛んだ先はちゃんと足されている（選択を畳むだけで終わっていない）
    await expect(screen.findByText("去年のきょう")).resolves.toBeDefined();
  });

  // 黙って消えると、押したはずの削除が効かなかったようにしか見えない
  it("says why the selection went away", async () => {
    await openScrawl();
    fireEvent.click(screen.getByRole("button", { name: "選択" }));
    fireEvent.click(screen.getByRole("button", { name: /朝ラン/u }));

    shell.refreshData();

    await waitFor(() => {
      expect(shell.toast()?.message).toBe("一覧を読み直したので選択を解除しました");
    });
  });

  // 選んでいないときの読み直しは、ただの再取得。言うことは何も無い
  it("stays quiet when nothing was selected", async () => {
    await openScrawl();

    shell.refreshData();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "選択" })).toBeDefined();
    });
    expect(shell.toast()).toBeNull();
  });
});
