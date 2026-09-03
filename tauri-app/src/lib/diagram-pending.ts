/**
 * 図は node view が非同期に描く。描き終わるまでブロックはソース(`pre`)の
 * 高さで並んでいて、図に置き換わった瞬間に下の本文がまとめて動く。その間に
 * 座標から文書上の位置を引くと、図より下は別のブロックを指す (#168)。
 *
 * 待つ側(カーソル配置)と描く側(node view)を繋ぐのは、このクラスと合図だけ。
 * クラスにしたのは、待つ側が node view のインスタンスを知らずに DOM への
 * 問い合わせ 1 回で「まだ描いている図があるか」を答えられるから。合図は
 * 待ち時間を締切いっぱい使わせないための通知で、状態はクラスが持つ。
 */
export const DIAGRAM_PENDING_CLASS = "is-diagram-pending";

/** 図が 1 つ描き終わったときに node view の DOM から浮かぶ(bubbles) */
export const DIAGRAM_SETTLED_EVENT = "diagram-settled";

/**
 * ブロックの描画中フラグを立てる/下ろす。下ろすときだけ合図を出す —
 * 高さが決まった後に呼ぶこと(合図を受けた側はその場で座標を読む)。
 */
export function setDiagramPending(dom: HTMLElement, pending: boolean): void {
  if (pending) {
    dom.classList.add(DIAGRAM_PENDING_CLASS);
    return;
  }
  if (!dom.classList.contains(DIAGRAM_PENDING_CLASS)) {
    return;
  }
  dom.classList.remove(DIAGRAM_PENDING_CLASS);
  dom.dispatchEvent(new CustomEvent(DIAGRAM_SETTLED_EVENT, { bubbles: true }));
}

/** まだ高さの決まっていない図が中にあるか */
export function hasPendingDiagram(root: ParentNode): boolean {
  return root.querySelector(`.${DIAGRAM_PENDING_CLASS}`) !== null;
}
