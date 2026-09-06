/**
 * キーボードから呼べる操作の表。押されたキーの判定・ボタンの肩に浮かせる札
 * (`data-key`)・パレット右端の表示を、すべてここから配る。三箇所に同じ
 * 「⌘N」を書くと、片方だけ直したときに嘘の札が残る。
 *
 * 修飾キーは macOS で ⌘、それ以外で Ctrl と綴るが、判定はどちらも受ける —
 * 外付けキーボードや Android のブラウザで、どちらが来るかは分からない。
 */

import { isMacDesktop } from "./platform";

interface Shortcut {
  /** `e.key` を小文字にした形。 */
  key: string;
  shift?: boolean;
}

const SHORTCUTS = {
  search: { key: "k" },
  newNote: { key: "n" },
  timeline: { key: "1" },
  notes: { key: "2" },
  syncNow: { key: "s", shift: true },
  settings: { key: "," },
  // 開いているノートに効くもの。受けるのは Workspace で、押せるのは
  // ノートを 1 件開いているあいだだけ
  noteActions: { key: "." },
  noteMap: { key: "m", shift: true },
  noteRevert: { key: "z", shift: true },
  noteInfo: { key: "i" },
  notePrev: { key: "arrowup" },
  noteNext: { key: "arrowdown" },
} as const satisfies Record<string, Shortcut>;

/** 矢印キーは名前をそのまま出しても読めない。札に出すのはこの綴り。 */
const PRINTED: Partial<Record<string, string>> = {
  arrowup: "↑",
  arrowdown: "↓",
};

export type ShortcutName = keyof typeof SHORTCUTS;

/**
 * ショートカット一覧を出すキー。修飾キーを伴わないので、入力中かどうかを
 * `isTypingTarget` で見てから拾う。
 */
export const SHORTCUT_LIST_KEY = "?";

/** ヒントの説明文に入れる修飾キーの名前。 */
export function modifierLabel(): string {
  return isMacDesktop() ? "⌘" : "Ctrl";
}

/** `⌘⇧S` / `Ctrl+Shift+S`。 */
export function shortcutLabel(name: ShortcutName): string {
  const { key, shift = false } = SHORTCUTS[name] as Shortcut;
  const printed = PRINTED[key] ?? key.toUpperCase();
  return isMacDesktop()
    ? `⌘${shift ? "⇧" : ""}${printed}`
    : `Ctrl+${shift ? "Shift+" : ""}${printed}`;
}

export function matchesShortcut(e: KeyboardEvent, name: ShortcutName): boolean {
  const { key, shift = false } = SHORTCUTS[name] as Shortcut;
  return (
    (e.metaKey || e.ctrlKey) &&
    // ⌥ が乗った組み合わせは OS と IME のもの。横取りすると入力が壊れる
    !e.altKey &&
    e.shiftKey === shift &&
    e.key.toLowerCase() === key
  );
}

/** そこで押された `?` が文字になる場所か。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.closest('[contenteditable="true"], [contenteditable=""]') !== null;
}
