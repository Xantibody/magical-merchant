import { describe, it, expect, afterEach } from "vitest";
import {
  SHORTCUT_LIST_KEY,
  isTypingTarget,
  matchesShortcut,
  modifierLabel,
  shortcutLabel,
  startsTypedSearch,
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

  // Upper-casing alone would give "ARROWUP". An arrow is printed as an arrow
  it("draws the arrows rather than naming them", () => {
    setUserAgent(MAC);

    expect(shortcutLabel("notePrev")).toBe("⌘↑");
    expect(shortcutLabel("noteNext")).toBe("⌘↓");
  });

  // The two ways into a Codex. Both appear in the badge at a button's shoulder and spelled
  // out on the rows of the overflow menu
  it("prints the keys the Codex answers to", () => {
    setUserAgent(MAC);

    expect(shortcutLabel("codexCommit")).toBe("⌘⇧K");
    expect(shortcutLabel("noteHistory")).toBe("⌘⇧H");
  });

  // The key that tucks the list beside a note. The grip's badge and the palette's row are
  // handed out from here
  it("prints the key that tucks the list", () => {
    setUserAgent(MAC);
    expect(shortcutLabel("sidebar")).toBe("⌘\\");

    setUserAgent(WINDOWS);
    expect(shortcutLabel("sidebar")).toBe("Ctrl+\\");
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
  // Which modifier arrives depends on the device and the keyboard, so both are accepted
  it("accepts either Meta or Control", () => {
    expect(matchesShortcut(press("1", { metaKey: true }), "scrawl")).toBe(true);
    expect(matchesShortcut(press("1", { ctrlKey: true }), "scrawl")).toBe(true);
  });

  // The surfaces open in the order 1, 2, 3. Codex is the third
  it("opens the third surface on the third digit", () => {
    expect(matchesShortcut(press("3", { metaKey: true }), "codex")).toBe(true);
  });

  it("does not fire without the modifier", () => {
    expect(matchesShortcut(press("1"), "scrawl")).toBe(false);
  });

  // If `⌘S` (which is bound to nothing) ran a sync, what was written would look lost
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

    // Inside Milkdown, the target at the moment of the press is an inner element such as a
    // paragraph
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

function pressed(init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function element(html: string): Element {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.append(holder);
  return holder.firstElementChild as Element;
}

describe("startsTypedSearch", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(["a", "あ", "1", "/"])("starts on %s from the page", (key) => {
    expect(startsTypedSearch(pressed({ key }))).toBe(true);
  });

  it.each(["Enter", "Tab", "ArrowDown", "Shift", "Escape", " "])("leaves %s alone", (key) => {
    expect(startsTypedSearch(pressed({ key }))).toBe(false);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { altKey: true }])("leaves %o alone", (mods) => {
    expect(startsTypedSearch(pressed({ key: "a", ...mods }))).toBe(false);
  });

  it.each([
    "<input />",
    "<textarea></textarea>",
    "<select></select>",
    '<div contenteditable="true"></div>',
  ])("never takes a key meant for %s", (html) => {
    expect(startsTypedSearch(pressed({ key: "a" }, element(html)))).toBe(false);
  });

  it("leaves the keys of a dialog or a menu to it", () => {
    const button = element('<div role="dialog"><button></button></div>').querySelector("button");

    expect(startsTypedSearch(pressed({ key: "a" }, button as Element))).toBe(false);
  });

  it("leaves a key the IME is working on", () => {
    expect(startsTypedSearch(pressed({ key: "a", isComposing: true }))).toBe(false);
    expect(startsTypedSearch(pressed({ key: "a", keyCode: 229 }))).toBe(false);
  });
});
