import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isMermaidLanguage, createDebouncedDiagramRenderer } from "./mermaid-preview";

const DELAY = 300;

type RenderFn = (source: string) => Promise<string | null>;
type ResultFn = (svg: string | null) => void;

/** 描画完了の順番をテスト側で並べ替えるための、外から解決できる Promise */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let stored!: (value: T) => void;
  // 解決を外から握るには executor を書くしかない
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<T>((resolve) => {
    stored = resolve;
  });
  return { promise, resolve: stored };
}

describe("isMermaidLanguage", () => {
  it("matches the exact language", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
  });

  // フェンスの info 文字列は手打ちなので、大文字や前後の空白はよくある揺れ
  it("ignores case and surrounding whitespace", () => {
    expect(isMermaidLanguage("Mermaid")).toBe(true);
    expect(isMermaidLanguage(" mermaid ")).toBe(true);
  });

  it("rejects other languages and the empty language", () => {
    expect(isMermaidLanguage("rust")).toBe(false);
    expect(isMermaidLanguage("")).toBe(false);
  });
});

describe("createDebouncedDiagramRenderer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders immediately when asked to", async () => {
    const render = vi.fn<RenderFn>().mockResolvedValue("<svg/>");
    const onResult = vi.fn<ResultFn>();
    const renderer = createDebouncedDiagramRenderer(render, onResult, DELAY);

    renderer.request("graph TD;", { immediate: true });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith("<svg/>"));

    expect(render).toHaveBeenCalledExactlyOnceWith("graph TD;");
  });

  it("waits for the delay before rendering", () => {
    const render = vi.fn<RenderFn>().mockResolvedValue("<svg/>");
    const renderer = createDebouncedDiagramRenderer(render, vi.fn<ResultFn>(), DELAY);

    renderer.request("graph TD;");
    vi.advanceTimersByTime(DELAY - 1);
    expect(render).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(render).toHaveBeenCalledExactlyOnceWith("graph TD;");
  });

  // 1 打鍵ごとに mermaid を回しては重すぎる。描くのは手が止まったあとの最新版だけ
  it("collapses a burst of requests into one render of the newest source", () => {
    const render = vi.fn<RenderFn>().mockResolvedValue("<svg/>");
    const renderer = createDebouncedDiagramRenderer(render, vi.fn<ResultFn>(), DELAY);

    renderer.request("graph T");
    vi.advanceTimersByTime(DELAY - 50);
    renderer.request("graph TD");
    vi.advanceTimersByTime(DELAY - 50);
    renderer.request("graph TD;");
    vi.advanceTimersByTime(DELAY);

    expect(render).toHaveBeenCalledExactlyOnceWith("graph TD;");
  });

  // 描画は非同期なので、古い描画が新しい描画を追い越して届くことがある
  it("drops a stale result that resolves after a newer request", async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    const render = vi.fn<RenderFn>();
    render.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onResult = vi.fn<ResultFn>();
    const renderer = createDebouncedDiagramRenderer(render, onResult, DELAY);

    renderer.request("old", { immediate: true });
    renderer.request("new", { immediate: true });
    second.resolve("<svg new/>");
    first.resolve("<svg old/>");
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledWith("<svg new/>"));

    expect(onResult).toHaveBeenCalledExactlyOnceWith("<svg new/>");
  });

  it("cancel discards both the pending timer and in-flight results", async () => {
    const inFlight = deferred<string | null>();
    const render = vi.fn<RenderFn>().mockReturnValueOnce(inFlight.promise);
    const onResult = vi.fn<ResultFn>();
    const renderer = createDebouncedDiagramRenderer(render, onResult, DELAY);

    renderer.request("graph TD;", { immediate: true });
    renderer.request("graph TD;x");
    renderer.cancel();
    vi.advanceTimersByTime(DELAY);
    inFlight.resolve("<svg/>");
    await Promise.resolve();

    expect(render).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("dispose stops all future requests", () => {
    const render = vi.fn<RenderFn>().mockResolvedValue("<svg/>");
    const renderer = createDebouncedDiagramRenderer(render, vi.fn<ResultFn>(), DELAY);

    renderer.dispose();
    renderer.request("graph TD;", { immediate: true });
    vi.advanceTimersByTime(DELAY);

    expect(render).not.toHaveBeenCalled();
  });
});
