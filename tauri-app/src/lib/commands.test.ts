import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { ClientContext } from "./client-context";
import { isStaleSave, onLocalMutation, typedInvoke } from "./commands";
// browser mode に node:fs は無い。Vite の `?raw` がソースをそのまま文字列で渡す。
// oxlint は `?raw` を知らず、素の .ts に default export を探しに行くので黙らせる
// oxlint-disable-next-line import/default
import commandsSource from "./commands.ts?raw";
import mockSource from "../../dev/ipc-mock.js?raw";

// vi.mock("@tauri-apps/api/core") は使わない。browser mode のモジュールモックは
// サーバー側の単一レジストリ越しに差し替えるため、並列実行下でモックが適用され
// ないまま本物の invoke が渡ることがある (vitest-dev/vitest#8339)。CI だけで
// 落ちる原因だった。mockIPC は window.__TAURI_INTERNALS__ を差し替えるだけで
// モジュールグラフに触らないので、この競合と無縁。
const CLIENT: ClientContext = {
  latitude: null,
  longitude: null,
  battery: null,
  isCharging: null,
  networkType: null,
  osVersion: null,
  locale: null,
};

describe("typedInvoke local mutation notifications", () => {
  const seen: string[] = [];
  let stop: () => void;

  beforeEach(() => {
    seen.length = 0;
    mockIPC(() => null);
    stop = onLocalMutation(() => seen.push("mutated"));
  });

  afterEach(() => {
    stop();
    clearMocks();
  });

  // 自動同期の合図。呼び出し側ごとに書くと必ず取りこぼす
  it("notifies after a write command succeeds", async () => {
    await typedInvoke("update_draft", { filePath: "a.md", body: "x", client: CLIENT });
    expect(seen).toHaveLength(1);
  });

  it("notifies for a quick capture", async () => {
    await typedInvoke("save_quick_capture", { text: "hi", client: CLIENT });
    expect(seen).toHaveLength(1);
  });

  it("stays quiet for read-only commands", async () => {
    mockIPC(() => []);
    await typedInvoke("list_notes");
    expect(seen).toHaveLength(0);
  });

  // 失敗した書き込みで同期すると、書けなかった内容を「同期済み」と見せてしまう
  it("stays quiet when the write fails", async () => {
    mockIPC(() => {
      throw new Error("disk full");
    });
    await expect(typedInvoke("delete_note", { filename: "a.md" })).rejects.toThrow("disk full");
    expect(seen).toHaveLength(0);
  });

  it("stops notifying once unsubscribed", async () => {
    stop();
    await typedInvoke("update_draft", { filePath: "a.md", body: "x", client: CLIENT });
    expect(seen).toHaveLength(0);
  });
});

/** Tauri の内部 API に公開の型は無い。テストが触るぶんだけ形を書く */
interface TauriInternals {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
}
const tauri = globalThis as unknown as TauriInternals;

/**
 * `CommandMap` は型なので実行時に列挙できない。宣言そのものを読んで名前を拾う。
 * 書き方が変わって 1 件も読めなくなったら、テストは静かに通らず落ちる。
 */
function declaredCommands(): string[] {
  const from = commandsSource.indexOf("interface CommandMap {");
  const block = commandsSource.slice(from, commandsSource.indexOf("\n}\n", from));
  return [...block.matchAll(/^ {2}(?<name>[a-z_]+): \{/gmu)]
    .map((match) => match.groups?.name)
    .filter((name) => name !== undefined);
}

// CLAUDE.md の「新しい Tauri コマンドには ipc-mock のハンドラを足す」を守らせる。
// 忘れるとブラウザ検証だけが `mock: unknown command` で死に、気付くのは
// dev-browser を開いた人になる
describe("dev/ipc-mock.js", () => {
  let previous: TauriInternals["__TAURI_INTERNALS__"];

  beforeAll(() => {
    previous = tauri.__TAURI_INTERNALS__;
    // モックは自分より先に誰かが居れば何もしない。譲る相手を先に退かす
    delete tauri.__TAURI_INTERNALS__;
    // `new Function` ではなく <script>。index.html に注入されるときと同じ経路で
    // `__TAURI_INTERNALS__` が置かれることまで見る
    const script = document.createElement("script");
    script.textContent = mockSource;
    document.head.append(script);
  });

  afterAll(() => {
    tauri.__TAURI_INTERNALS__ = previous;
  });

  it("answers every command declared in CommandMap", async () => {
    const names = declaredCommands();
    // 0 件は「モックが完璧」ではなく「正規表現が宣言の書き方から外れた」
    expect(names.length).toBeGreaterThan(0);

    const invoke = tauri.__TAURI_INTERNALS__?.invoke;
    const answers = await Promise.all(
      names.map(async (name) => {
        try {
          // 引数は渡さない。ハンドラが中で転ぶのは構わない。見たいのは
          // 「そのコマンドを知っているか」だけ
          await invoke?.(name, {});
          return `${name}: ok`;
        } catch (error) {
          return `${name}: ${String(error)}`;
        }
      }),
    );
    expect(answers.filter((answer) => answer.includes("unknown command"))).toStrictEqual([]);
  });
});

describe("isStaleSave", () => {
  // update_draft の失敗は kind 付きで届く。stale だけが「読み直して知らせる」に分岐する
  it("recognises the stale kind and nothing else", () => {
    expect(isStaleSave({ kind: "stale", message: "Stale: a.md changed" })).toBe(true);
    expect(isStaleSave({ kind: "other", message: "disk full" })).toBe(false);
    expect(isStaleSave(new Error("stale"))).toBe(false);
    expect(isStaleSave("stale")).toBe(false);
  });
});
