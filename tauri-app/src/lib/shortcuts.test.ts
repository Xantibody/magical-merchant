import { describe, it, expect, afterEach } from "vitest";
import {
  SHORTCUT_LIST_KEY,
  isTypingTarget,
  matchesShortcut,
  modifierLabel,
  shortcutLabel,
} from "./shortcuts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

function press(key: string, modifiers: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ...modifiers });
}

describe("shortcutLabel", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "userAgent");
  });

  it("prints the macOS symbols", () => {
    setUserAgent(MAC);

    expect(shortcutLabel("newNote")).toBe("⌘N");
    expect(shortcutLabel("syncNow")).toBe("⌘⇧S");
    expect(shortcutLabel("settings")).toBe("⌘,");
  });

  // 大文字にするだけでは「ARROWUP」になる。矢印は矢印で出す
  it("draws the arrows rather than naming them", () => {
    setUserAgent(MAC);

    expect(shortcutLabel("notePrev")).toBe("⌘↑");
    expect(shortcutLabel("noteNext")).toBe("⌘↓");
  });

  it("spells the modifier out everywhere else", () => {
    setUserAgent(WINDOWS);

    expect(shortcutLabel("newNote")).toBe("Ctrl+N");
    expect(shortcutLabel("syncNow")).toBe("Ctrl+Shift+S");
  });

  it("names the modifier for the hint pill", () => {
    setUserAgent(MAC);
    expect(modifierLabel()).toBe("⌘");

    setUserAgent(WINDOWS);
    expect(modifierLabel()).toBe("Ctrl");
  });
});

describe("matchesShortcut", () => {
  // 修飾キーがどちらで来るかは端末とキーボード次第なので、両方受ける
  it("accepts either Meta or Control", () => {
    expect(matchesShortcut(press("1", { metaKey: true }), "timeline")).toBe(true);
    expect(matchesShortcut(press("1", { ctrlKey: true }), "timeline")).toBe(true);
  });

  it("does not fire without the modifier", () => {
    expect(matchesShortcut(press("1"), "timeline")).toBe(false);
  });

  // ⌘S(そんな割り当ては無い)で同期が走ると、書いたものが消えたように見える
  it("keeps ⌘⇧S apart from ⌘S", () => {
    expect(matchesShortcut(press("S", { metaKey: true, shiftKey: true }), "syncNow")).toBe(true);
    expect(matchesShortcut(press("s", { metaKey: true }), "syncNow")).toBe(false);
  });

  it("ignores a shortcut that carries an extra Shift", () => {
    expect(matchesShortcut(press("N", { metaKey: true, shiftKey: true }), "newNote")).toBe(false);
  });

  it("ignores Option/Alt combinations, which belong to the system", () => {
    expect(matchesShortcut(press("n", { metaKey: true, altKey: true }), "newNote")).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("recognises the places a bare ? is a character", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);

    // Milkdown の中では、押した瞬間の target は段落など内側の要素になる
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.append(paragraph);
    expect(isTypingTarget(editor)).toBe(true);
    expect(isTypingTarget(paragraph)).toBe(true);
  });

  it("lets the key through anywhere else", () => {
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("is the key the shortcut list answers to", () => {
    expect(SHORTCUT_LIST_KEY).toBe("?");
  });
});
