import { describe, it, expect } from "vitest";
import { isMacDesktop } from "./platform";

const MAC_WKWEBVIEW =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36";
const IPAD_SAFARI =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const WINDOWS_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

describe("isMacDesktop", () => {
  it("recognises the macOS WKWebView", () => {
    expect(isMacDesktop(MAC_WKWEBVIEW)).toBe(true);
  });

  it("is false on Android", () => {
    expect(isMacDesktop(ANDROID_WEBVIEW)).toBe(false);
  });

  // iPad の UA にも "Mac OS X" が出る。ネイティブの全画面は Mac だけの話
  it("is false on an iPad even though its user agent mentions Mac OS X", () => {
    expect(isMacDesktop(IPAD_SAFARI)).toBe(false);
  });

  it("is false on Windows", () => {
    expect(isMacDesktop(WINDOWS_WEBVIEW2)).toBe(false);
  });

  it("is false for an empty user agent", () => {
    expect(isMacDesktop("")).toBe(false);
  });
});
