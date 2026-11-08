import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { cdp } from "vitest/browser";
import { render, fireEvent, cleanup, screen } from "@solidjs/testing-library";
import CaptureBar from "./CaptureBar";

function renderCaptureBar() {
  const onSend = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const onPromote = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const onError = vi.fn<() => void>();
  const onTyping = vi.fn<(typing: boolean) => void>();
  const onSearch = vi.fn<() => void>();
  const onNewNote = vi.fn<() => void>();
  const onJumpToDate = vi.fn<(trigger: HTMLElement) => void>();
  const { container } = render(() => (
    <CaptureBar
      onSend={onSend}
      onPromote={onPromote}
      onError={onError}
      onTyping={onTyping}
      onSearch={onSearch}
      onNewNote={onNewNote}
      onJumpToDate={onJumpToDate}
      knownTags={[{ tag: "sync", count: 2 }]}
    />
  ));
  const textarea = container.querySelector<HTMLTextAreaElement>(".capture-input");
  if (!textarea) {
    throw new Error("capture-input not found");
  }
  return { onSend, onPromote, onError, onTyping, onSearch, onNewNote, onJumpToDate, textarea };
}

describe("CaptureBar", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  // An entry is written only on send, so a half-typed capture lived in a signal alone and
  // went with the process when the phone put the app away. It is not sent on its own: an
  // entry is a timestamped record and a half-typed one is not what was meant. It waits
  it("keeps the half-typed text on the device", () => {
    const { textarea } = renderCaptureBar();

    fireEvent.input(textarea, { target: { value: "買い物の途中で" } });

    expect(localStorage.getItem("scrawl-draft")).toBe("買い物の途中で");
  });

  it("brings the half-typed text back when the bar is shown again", () => {
    localStorage.setItem("scrawl-draft", "途中まで");

    const { textarea } = renderCaptureBar();

    expect(textarea.value).toBe("途中まで");
  });

  it("forgets the text once it has been sent", async () => {
    const { textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "買い物" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    await Promise.resolve();

    expect(textarea.value).toBe("");
    expect(localStorage.getItem("scrawl-draft")).toBeNull();
  });

  it("sends the trimmed text on Enter", () => {
    const { onSend, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "買い物メモ " } });

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledExactlyOnceWith("買い物メモ");
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    "hands the text to a Note on %o + Enter instead of recording it",
    async (modifier) => {
      const { onSend, onPromote, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "週次の振り返り " } });

      fireEvent.keyDown(textarea, { key: "Enter", ...modifier });
      await Promise.resolve();

      expect(onPromote).toHaveBeenCalledExactlyOnceWith("週次の振り返り");
      expect(onSend).not.toHaveBeenCalled();
      expect(localStorage.getItem("scrawl-draft")).toBeNull();
    },
  );

  it("leaves the Enter that ends a conversion to the IME even with the modifier", () => {
    const { onPromote, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "かんじへんかん" } });

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, isComposing: true });

    expect(onPromote).not.toHaveBeenCalled();
  });

  // The line shows its time and dot only then, so an empty line does not read as a record
  it("says whether anything is typed", () => {
    const { onTyping, textarea } = renderCaptureBar();
    expect(onTyping).toHaveBeenLastCalledWith(false);

    fireEvent.input(textarea, { target: { value: "あ" } });
    expect(onTyping).toHaveBeenLastCalledWith(true);

    fireEvent.input(textarea, { target: { value: "  " } });
    expect(onTyping).toHaveBeenLastCalledWith(false);
  });

  it.each(["買い物と明日の予定", "次の記録"])(
    "keeps edits made during a send: %s",
    async (edited) => {
      const { onSend, textarea } = renderCaptureBar();
      const pending = Promise.withResolvers<void>();
      onSend.mockReturnValueOnce(pending.promise);
      fireEvent.input(textarea, { target: { value: "買い物" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      fireEvent.input(textarea, { target: { value: edited } });
      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(onSend).toHaveBeenCalledExactlyOnceWith("買い物");

      pending.resolve();
      await pending.promise;

      expect(textarea.value).toBe(edited);
      fireEvent.keyDown(textarea, { key: "Enter" });
      await Promise.resolve();
      expect(onSend).toHaveBeenLastCalledWith(edited);
      expect(textarea.value).toBe("");
    },
  );

  it("keeps the latest draft when an earlier send fails", async () => {
    const { onSend, onError, textarea } = renderCaptureBar();
    const pending = Promise.withResolvers<void>();
    onSend.mockReturnValueOnce(pending.promise);
    fireEvent.input(textarea, { target: { value: "送信した文章" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.input(textarea, { target: { value: "送信中に追記した文章" } });

    pending.reject(new Error("disk full"));
    await expect.poll(() => onError.mock.calls.length).toBe(1);

    expect(textarea.value).toBe("送信中に追記した文章");
    fireEvent.keyDown(textarea, { key: "Enter" });
    await Promise.resolve();
    expect(onSend).toHaveBeenLastCalledWith("送信中に追記した文章");
    expect(textarea.value).toBe("");
  });

  describe("the / menu", () => {
    it.each(["/", "／"])("opens on %s at the head of the line", (slash) => {
      const { textarea } = renderCaptureBar();

      fireEvent.input(textarea, { target: { value: slash } });

      expect(screen.getAllByRole("option").map((row) => row.textContent)).toStrictEqual([
        "探す",
        "Note を作る",
        "日付へ",
      ]);
    });

    it("narrows by what follows the slash", () => {
      const { textarea } = renderCaptureBar();

      fireEvent.input(textarea, { target: { value: "/日" } });

      expect(screen.getAllByRole("option").map((row) => row.textContent)).toStrictEqual(["日付へ"]);
    });

    // A line may well begin with a path. It is a record unless a row was offered
    it.each(["/usr/bin を調べた", "/tmp", "a/b"])("records %s as written", (line) => {
      const { onSend, onSearch, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: line } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(screen.queryByRole("option")).toBeNull();
      expect(onSend).toHaveBeenCalledExactlyOnceWith(line);
      expect(onSearch).not.toHaveBeenCalled();
    });

    it.each(["Enter", "Tab"])("picks the first row with %s, and the line empties", (key) => {
      const { onSend, onSearch, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "/" } });

      fireEvent.keyDown(textarea, { key });

      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea.value).toBe("");
      expect(localStorage.getItem("scrawl-draft")).toBeNull();
    });

    it("moves with the arrows", () => {
      const { onNewNote, onJumpToDate, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "/" } });

      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "Enter" });
      fireEvent.input(textarea, { target: { value: "/" } });
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(onNewNote).toHaveBeenCalledTimes(1);
      expect(onJumpToDate).toHaveBeenCalledExactlyOnceWith(textarea);
    });

    it("picks with the mouse", () => {
      const { onNewNote, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "/" } });

      fireEvent.mouseDown(screen.getByRole("option", { name: "Note を作る" }));

      expect(onNewNote).toHaveBeenCalledTimes(1);
    });

    it("folds on Esc and leaves the text to record", () => {
      const { onSend, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "/" } });

      fireEvent.keyDown(textarea, { key: "Escape" });
      expect(screen.queryByRole("option")).toBeNull();

      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(onSend).toHaveBeenCalledExactlyOnceWith("/");
    });

    // Arrows and Enter during a conversion choose its candidates (#102)
    it.each([{ isComposing: true }, { keyCode: 229 }])("leaves the keys to the IME: %o", (ime) => {
      const { onSearch, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "／" } });

      fireEvent.keyDown(textarea, { key: "ArrowDown", ...ime });
      fireEvent.keyDown(textarea, { key: "Enter", ...ime });
      fireEvent.keyDown(textarea, { key: "Tab", ...ime });

      expect(onSearch).not.toHaveBeenCalled();
      expect(screen.getByRole("option", { name: "探す" }).getAttribute("aria-selected")).toBe(
        "true",
      );
    });

    it("picks a tag with Tab too", () => {
      const { textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "#sy" } });

      fireEvent.keyDown(textarea, { key: "Tab" });

      expect(textarea.value).toBe("#sync ");
    });
  });

  // In the WKWebView on macOS, the Enter that commits a Japanese IME conversion also
  // arrives as a keydown. Sending without looking at isComposing makes it impossible to
  // commit a kanji conversion (#102)
  it("does not send while the IME is composing", () => {
    const { onSend, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "かんじへんかん" } });

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  // For compatibility, WebKit sometimes delivers a keydown during composition as keyCode 229
  it("does not send on the legacy keyCode 229 Enter", () => {
    const { onSend, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "かんじへんかん" } });

    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
  });
});

const height = (el: HTMLElement): number => el.getBoundingClientRect().height;
const lineHeight = (el: HTMLElement): number => Number.parseFloat(getComputedStyle(el).lineHeight);
const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

/**
 * The line grows with what is typed and scrolls past six lines. Chrome and a recent WebKit size
 * it from the stylesheet; an older WKWebView has it measured on each key instead.
 */
describe.each([
  { path: "the browser", sizesItself: true },
  { path: "the measured fallback", sizesItself: false },
])("CaptureBar sizing through $path", ({ sizesItself }) => {
  beforeAll(async () => {
    await import("../index.css");
  });

  beforeEach(() => {
    const supports = CSS.supports.bind(CSS);
    vi.spyOn(CSS, "supports").mockImplementation((property: string, value?: string) =>
      property === "field-sizing" ? sizesItself : supports(property, value ?? ""),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("grows with the lines typed and goes back to one after a send", async () => {
    const { textarea } = renderCaptureBar();
    const empty = height(textarea);

    fireEvent.input(textarea, { target: { value: lines(3) } });
    expect(height(textarea)).toBeCloseTo(empty + 2 * lineHeight(textarea), 0);

    fireEvent.keyDown(textarea, { key: "Enter" });
    await expect.poll(() => height(textarea)).toBeCloseTo(empty, 0);
  });

  it("stops at six lines and scrolls the rest", () => {
    const { textarea } = renderCaptureBar();

    fireEvent.input(textarea, { target: { value: lines(10) } });

    expect(height(textarea)).toBeCloseTo(6 * lineHeight(textarea), 0);
    expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
  });
});

/** How many layouts Chromium has run so far. */
async function layoutCount(): Promise<number> {
  const { metrics } = (await cdp().send("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return metrics.find((metric) => metric.name === "LayoutCount")?.value ?? 0;
}

/**
 * Reading the height back on a key made the page lay out twice for it, the day list below
 * the line included. Where the browser sizes the line itself, a key must not force a layout.
 */
describe("CaptureBar sizing cost", () => {
  beforeAll(async () => {
    await import("../index.css");
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("forces no layout on a key where the browser sizes the line", async () => {
    expect(CSS.supports("field-sizing", "content")).toBe(true);
    await cdp().send("Performance.enable");
    const { textarea } = renderCaptureBar();
    const typed = "きょうは雨\n午後は晴れた";
    // The mount's own layout lands before the count starts
    const painted = Promise.withResolvers<number>();
    requestAnimationFrame(painted.resolve);
    await painted.promise;

    const before = await layoutCount();
    for (let i = 1; i <= typed.length; i++) {
      fireEvent.input(textarea, { target: { value: typed.slice(0, i) } });
    }
    const after = await layoutCount();

    // One layout may still land between the keys and the read: the frame that draws them
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
