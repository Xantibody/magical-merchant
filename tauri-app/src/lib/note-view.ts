/**
 * ノートの表示モード。frontmatter の `view` キーとの相互変換を一箇所に寄せる。
 *
 * キーは「書いてあるときだけ意味を持つ」約束にしてある。既定のエディタ表示を
 * わざわざ書くと、切り替えたことのないノートまで frontmatter が書き換わり、
 * 内容ハッシュが変わった扱いになり、同期が無変更のノートを転送し直すことになる。
 */

export type NoteView = "editor" | "mindmap" | "preview";

/** frontmatter の `view` の値を表示モードに解決する。未知の値はエディタに倒す。 */
export function resolveNoteView(view?: string): NoteView {
  return view === "mindmap" || view === "preview" ? view : "editor";
}

/** frontmatter に書く値。既定のエディタ表示はキーごと消す(null)。 */
export function viewToFrontmatter(view: NoteView): string | null {
  return view === "editor" ? null : view;
}

export interface NoteContent {
  body: string;
  view: NoteView;
  /** 読んだ時点の本文の指紋。保存に添える。 */
  revision: string;
}

/**
 * 本文と表示モードを対で読む。別々に画面へ流すと、先に届いた本文が一瞬
 * 違うモードで描かれる(マインドマップのノートが Markdown で光ってから
 * 差し替わる)。メタの読み損ねは既定のエディタ表示に倒すが、本文の
 * 読み損ねはごまかさない — 空のノートに見せるほうが害が大きい。
 */
export async function readNoteContent(
  readBody: () => Promise<{ body: string; revision: string }>,
  readMeta: () => Promise<{ view?: string }>,
): Promise<NoteContent> {
  const [{ body, revision }, view] = await Promise.all([
    readBody(),
    readMeta().then(
      (meta) => resolveNoteView(meta.view),
      () => "editor" as const,
    ),
  ]);
  return { body, view, revision };
}
