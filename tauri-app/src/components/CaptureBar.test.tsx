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

  // macOS の WKWebView では、日本語 IME の変換確定 Enter も keydown として
  // 届く。isComposing を見ずに送信すると、漢字変換を確定できない (#102)
  it("does not send while the IME is composing", () => {
    const { onSend, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "かんじへんかん" } });

    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  // WebKit は互換のため合成中の keydown を keyCode 229 で届けることがある
  it("does not send on the legacy keyCode 229 Enter", () => {
    const { onSend, textarea } = renderCaptureBar();
    fireEvent.input(textarea, { target: { value: "かんじへんかん" } });

    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
  });
});
