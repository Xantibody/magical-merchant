import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCopyFeedback } from "./copy-feedback";

const RESET = 1500;

type WriteFn = (text: string) => Promise<void>;
type StateFn = (copied: boolean) => void;

/** A Promise resolvable from outside, so the test controls when the write completes */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let storedResolve!: () => void;
  let storedReject!: () => void;
  // Writing an executor is the only way to hold the resolution from outside
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<void>((resolve, reject) => {
    storedResolve = resolve;
    storedReject = reject;
  });
  return { promise, resolve: storedResolve, reject: storedReject };
}

/** vi.waitFor would advance the timers too, so run only the microtasks */
function flushMicrotasks(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0);
}

describe("createCopyFeedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  // So repeated presses do not make the "copied" state flicker, only the last press's reset counts
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

  // Where the clipboard is unavailable, do nothing silently. Better than a false "copied"
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
