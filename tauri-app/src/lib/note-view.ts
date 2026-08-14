/**
 * ノートの表示モード。frontmatter の `view` キーとの相互変換を一箇所に寄せる。
 *
 * キーは「書いてあるときだけ意味を持つ」約束にしてある。既定のエディタ表示を
 * わざわざ書くと、切り替えたことのないノートまで frontmatter が書き換わり、
 * 同期(Syncthing)が無変更のノートを転送し直すことになる。
 */

export type NoteView = "editor" | "mindmap";

/** frontmatter の `view` の値を表示モードに解決する。未知の値はエディタに倒す。 */
export function resolveNoteView(view?: string): NoteView {
  return view === "mindmap" ? "mindmap" : "editor";
}

export function toggledView(view: NoteView): NoteView {
  return view === "mindmap" ? "editor" : "mindmap";
}

/** frontmatter に書く値。既定のエディタ表示はキーごと消す(null)。 */
export function viewToFrontmatter(view: NoteView): string | null {
  return view === "mindmap" ? "mindmap" : null;
}
