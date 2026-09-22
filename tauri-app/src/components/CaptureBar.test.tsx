import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@solidjs/testing-library";
import CaptureBar from "./CaptureBar";

function renderCaptureBar() {
  const onSend = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
  const { container } = render(() => <CaptureBar onSend={onSend} />);
  const textarea = container.querySelector<HTMLTextAreaElement>(".capture-input");
  if (!textarea) {
    throw new Error("capture-input not found");
  }
  return { onSend, textarea };
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
