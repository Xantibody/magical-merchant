import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { cdp } from "vitest/browser";
import { render, fireEvent, cleanup, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import CaptureBar from "./CaptureBar";
import { setLocale } from "../lib/i18n";

function pause(ms: number): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Where a fan pill's round mark is meant to stand, read from the place the fan gave it: the
 * test page has no stylesheet to lay the fixed layer out, so its box is not where the slide reads
 * it. Which side the fan opens on follows where send lands, and unstyled that moves with the
 * font's width (left of the middle on macOS, right of it on the CI's Linux): the pill is given
 * its `left` on one side and its `right` on the other (Ring's `pillEdge`).
 */
function markOf(pill: HTMLElement): { clientX: number; clientY: number } {
  const half = 23;
  const width = document.documentElement.clientWidth || globalThis.innerWidth;
  const clientX = pill.style.left
    ? Number.parseFloat(pill.style.left) + half
    : width - Number.parseFloat(pill.style.right) - half;
  return { clientX, clientY: Number.parseFloat(pill.style.top) + half };
}

function renderCaptureBar() {
  const onSend = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const onPromote = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const onError = vi.fn<() => void>();
  const onSearch = vi.fn<() => void>();
  const onNewNote = vi.fn<() => void>();
  const onJumpToDate = vi.fn<(trigger: HTMLElement) => void>();
  const { container } = render(() => (
    <CaptureBar
      onSend={onSend}
      onPromote={onPromote}
      onError={onError}
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
  return { onSend, onPromote, onError, onSearch, onNewNote, onJumpToDate, textarea };
}

describe("CaptureBar", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    localStorage.clear();
    setLocale("ja");
  });

  // The phone's send button is an icon, so this name is all a screen reader has. It was
  // English on a Japanese screen
  it("names the send button in the reader's language", () => {
    renderCaptureBar();

    expect(screen.getByRole("button", { name: "記録する", hidden: true })).toBeDefined();

    setLocale("en");
    expect(screen.getByRole("button", { name: "Send", hidden: true })).toBeDefined();
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

  // 71: a tag pressed beside the field joins the line at the caret, set apart by spaces, and
  // the caret goes on after it so the next word follows without a tap
  it("adds a pressed tag at the caret and keeps the caret after it", async () => {
    localStorage.setItem("scrawl-draft", "牛乳を買う");
    const [add, setAdd] = createSignal<{ tag: string } | null>(null);
    const { container } = render(() => (
      <CaptureBar
        onSend={vi.fn<(text: string) => Promise<void>>().mockResolvedValue()}
        onPromote={vi.fn<(text: string) => Promise<void>>().mockResolvedValue()}
        onError={vi.fn<() => void>()}
        onSearch={vi.fn<() => void>()}
        onNewNote={vi.fn<() => void>()}
        onJumpToDate={vi.fn<(trigger: HTMLElement) => void>()}
        addTag={add()}
      />
    ));
    const textarea = container.querySelector<HTMLTextAreaElement>(".capture-input");
    textarea?.setSelectionRange(5, 5);

    setAdd({ tag: "家" });
    await Promise.resolve();

    expect(textarea?.value).toBe("牛乳を買う #家 ");
    expect(textarea?.selectionStart).toBe("牛乳を買う #家 ".length);
    expect(localStorage.getItem("scrawl-draft")).toBe("牛乳を買う #家 ");
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

  // 5: a phone has no ⌘Enter, so the same choice is send slid up (or held) onto a Note pill. A
  // press let go on send records, however long it was held
  describe("the slid send", () => {
    const base = { pointerType: "touch", bubbles: true, pointerId: 5, button: 0 };

    /** Pressed on send at the foot, where the line sits on a phone; the pill opens above it. */
    function pressSend(): { send: HTMLElement; start: { clientX: number; clientY: number } } {
      const bar = document.querySelector<HTMLElement>(".capture-bar");
      bar?.style.setProperty("position", "fixed");
      bar?.style.setProperty("inset", "auto 16px 16px 16px");
      bar?.style.setProperty("display", "flex");
      const send = screen.getByRole("button", { name: "記録する" });
      const box = send.getBoundingClientRect();
      const start = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      send.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...start }));
      return { send, start };
    }

    /** Lets go at `end`, and the click a real release on the button would follow with. */
    function release(send: HTMLElement, end: { clientX: number; clientY: number }): void {
      send.dispatchEvent(new PointerEvent("pointermove", { ...base, ...end }));
      send.dispatchEvent(new PointerEvent("pointerup", { ...base, ...end }));
      fireEvent.click(send);
    }

    it("makes a Note of the line when slid up onto the pill", async () => {
      const { onSend, onPromote, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "週次の振り返り" } });

      const { send, start } = pressSend();
      // A slide up opens it at once, with no hold to wait for
      send.dispatchEvent(
        new PointerEvent("pointermove", { ...base, ...start, clientY: start.clientY - 24 }),
      );
      release(send, markOf(screen.getByRole("menuitem", { name: "Note にする" })));

      await expect.poll(() => onPromote.mock.calls).toStrictEqual([["週次の振り返り"]]);
      expect(onSend).not.toHaveBeenCalled();
    });

    it("records a slow press let go on send, once", async () => {
      const { onSend, onPromote, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "牛乳" } });

      const { send, start } = pressSend();
      await pause(420);
      // The hold has shown the Note pill, but letting go in place is still a send
      expect(screen.getByRole("menuitem", { name: "Note にする" })).toBeDefined();
      release(send, start);

      await expect.poll(() => onSend.mock.calls).toStrictEqual([["牛乳"]]);
      expect(onPromote).not.toHaveBeenCalled();
      expect(screen.queryByRole("menuitem")).toBeNull();
    });

    it("keeps the line when let go off both send and the pill", async () => {
      const { onSend, onPromote, textarea } = renderCaptureBar();
      fireEvent.input(textarea, { target: { value: "あとで書く" } });

      const { send, start } = pressSend();
      send.dispatchEvent(
        new PointerEvent("pointermove", { ...base, ...start, clientY: start.clientY - 24 }),
      );
      release(send, { clientX: 20, clientY: start.clientY - 24 });
      await pause(20);

      expect(onSend).not.toHaveBeenCalled();
      expect(onPromote).not.toHaveBeenCalled();
      expect(textarea.value).toBe("あとで書く");
    });
  });

  it("leaves the Enter that ends a conversion to the IME even with the modifier", () => {
    const { onPromote, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "かんじへんかん" } });

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, isComposing: true });

    expect(onPromote).not.toHaveBeenCalled();
  });

  // The placeholder is a short question; what else the field answers to goes in the hint
  it("asks a short question and leaves the keys to the hint", () => {
    const { textarea } = renderCaptureBar();

    expect(textarea.placeholder).toBe("いま何を記録する？");
    expect(document.querySelector(".capture-hint")?.textContent).toContain("# タグ");
  });

  // S2: the next line follows at once. On a phone a lost focus also drops the keyboard
  it("keeps the focus in the field after a send", async () => {
    const { onSend, textarea } = renderCaptureBar();
    textarea.focus();
    fireEvent.input(textarea, { target: { value: "一行目" } });

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await expect.poll(() => onSend.mock.calls.length).toBe(1);
    await expect.poll(() => textarea.value).toBe("");
    expect(document.activeElement).toBe(textarea);
  });

  // The press itself must not move the focus off the field before the click sends
  it("does not take the focus when the send button is pressed", () => {
    const { textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "一行目" } });

    const pressed = fireEvent.mouseDown(screen.getByRole("button", { name: "記録する" }));

    expect(pressed).toBe(false);
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
 * The field grows with what is typed and scrolls past five lines. Chrome and a recent WebKit size
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

  /**
   * Chromium keeps applying the stylesheet's `field-sizing` whatever `CSS.supports` answers, so
   * the fallback is mounted with it turned off; only the script can size the line then.
   */
  const mount = (): ReturnType<typeof renderCaptureBar> => {
    const bar = renderCaptureBar();
    if (!sizesItself) {
      bar.textarea.style.setProperty("field-sizing", "fixed");
    }
    return bar;
  };

  it("grows with the lines typed and goes back to one after a send", async () => {
    const { textarea } = mount();
    const empty = height(textarea);

    fireEvent.input(textarea, { target: { value: lines(3) } });
    expect(height(textarea)).toBeCloseTo(empty + 2 * lineHeight(textarea), 0);

    fireEvent.keyDown(textarea, { key: "Enter" });
    await expect.poll(() => height(textarea)).toBeCloseTo(empty, 0);
  });

  it("stops at five lines and scrolls the rest", () => {
    const { textarea } = mount();

    fireEvent.input(textarea, { target: { value: lines(10) } });

    expect(height(textarea)).toBeCloseTo(5 * lineHeight(textarea), 0);
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
