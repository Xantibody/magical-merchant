import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCopyFeedback } from "./copy-feedback";

const RESET = 1500;

type WriteFn = (text: string) => Promise<void>;
type StateFn = (copied: boolean) => void;

/** 書き込み完了の順番をテスト側で握るための、外から解決できる Promise */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let storedResolve!: () => void;
  let storedReject!: () => void;
  // 解決を外から握るには executor を書くしかない
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve, reject) => {
    storedResolve = resolve;
    storedReject = reject;
  });
  return { promise, resolve: storedResolve, reject: storedReject };
}

/** vi.waitFor はタイマーも進めてしまうので、マイクロタスクだけを流す */
function flushMicrotasks(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCopyFeedback", () => {
  it("writes the text, reports copied, and resets after the delay", async () => {
    const write = vi.fn<WriteFn>(() => Promise.resolve());
    const onState = vi.fn<StateFn>();
    const feedback = createCopyFeedback(write, onState, RESET);

    feedback.copy("const a = 1;");
    await flushMicrotasks();

    expect(onState).toHaveBeenCalledExactlyOnceWith(true);
    expect(write).toHaveBeenCalledExactlyOnceWith("const a = 1;");
    vi.advanceTimersByTime(RESET);
    expect(onState).toHaveBeenLastCalledWith(false);
  });

  // 連打しても「コピー済み」表示がチカチカしないよう、リセットは最後の 1 回分だけ
  it("restarts the reset timer when copy is pressed again", async () => {
    const write = vi.fn<WriteFn>(() => Promise.resolve());
    const onState = vi.fn<StateFn>();
    const feedback = createCopyFeedback(write, onState, RESET);

    feedback.copy("a");
    await flushMicrotasks();
    vi.advanceTimersByTime(RESET - 100);
    feedback.copy("a");
    await flushMicrotasks();
    expect(onState).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(RESET - 100);
    expect(onState).not.toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(100);
    expect(onState).toHaveBeenLastCalledWith(false);
  });

  // クリップボードが使えない環境では黙って何もしない。誤った「コピー済み」を出すよりよい
  it("reports nothing when the clipboard write fails", async () => {
    const failure = deferred();
    const write = vi.fn<WriteFn>().mockReturnValue(failure.promise);
    const onState = vi.fn<StateFn>();
    const feedback = createCopyFeedback(write, onState, RESET);

    feedback.copy("a");
    failure.reject();
    await Promise.resolve();
    vi.advanceTimersByTime(RESET);

    expect(onState).not.toHaveBeenCalled();
  });

  it("dispose drops pending resets and in-flight writes", async () => {
    const inFlight = deferred();
    const write = vi.fn<WriteFn>().mockReturnValue(inFlight.promise);
    const onState = vi.fn<StateFn>();
    const feedback = createCopyFeedback(write, onState, RESET);

    feedback.copy("a");
    feedback.dispose();
    inFlight.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(RESET);

    expect(onState).not.toHaveBeenCalled();
  });
});
