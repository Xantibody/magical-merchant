/**
 * ノート 1 件を開く URL。Note と Codex は別の面に住むので、ID だけを
 * `/notes?file=` に載せると Codex は開いた先に居ない。開く経路(パレット・
 * ウィジェット・バックリンク・チップ)は全部ここを通す — 面が 1 つ増える
 * たびに経路ごとの分岐を書かない。
 */

import type { NoteKind } from "./commands";
import { ROUTES } from "./routes";

export function noteRoute(kind: NoteKind, filename?: string): string {
  const base = kind === "codex" ? ROUTES.CODEX : ROUTES.NOTES;
  return filename ? `${base}?file=${encodeURIComponent(filename)}` : base;
}
