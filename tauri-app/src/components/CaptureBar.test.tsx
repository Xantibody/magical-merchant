import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@solidjs/testing-library";
import CaptureBar from "./CaptureBar";

function renderCaptureBar() {
  const onSend = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const onError = vi.fn<() => void>();
  const { container } = render(() => <CaptureBar onSend={onSend} onError={onError} />);
  const textarea = container.querySelector<HTMLTextAreaElement>(".capture-input");
  if (!textarea) {
    throw new Error("capture-input not found");
  }
  return { onSend, onError, textarea };
}

describe("CaptureBar", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  it("sends the trimmed text on Enter", () => {
    const { onSend, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "買い物メモ " } });

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledExactlyOnceWith("買い物メモ");
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
