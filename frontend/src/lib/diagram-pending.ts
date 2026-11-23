/**
 * A node view draws a diagram asynchronously. Until it finishes, the block is laid
 * out at the height of its source (`pre`), and the body below it all shifts the
 * moment the diagram replaces it. Resolving a document position from coordinates
 * during that window points at the wrong block below the diagram (#168).
 *
 * The waiting side (cursor placement) and the drawing side (node view) are joined
 * only by this CSS class and the event. A class is used because the waiting side
 * can then answer "is a diagram still being drawn?" with one DOM query, without
 * knowing the node view instance. The event is a notification, so the wait does
 * not have to run to its deadline; the state lives on the class.
 */
export const DIAGRAM_PENDING_CLASS = "is-diagram-pending";

/** Bubbles out of the node view DOM when one diagram has finished drawing */
export const DIAGRAM_SETTLED_EVENT = "diagram-settled";

/**
 * Raises or clears the block's drawing flag. Only clearing emits the event: call
 * it after the height is settled, because the receiver reads coordinates at once.
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

/** Whether a diagram whose height is not settled yet is inside */
export function hasPendingDiagram(root: ParentNode): boolean {
  return root.querySelector(`.${DIAGRAM_PENDING_CLASS}`) !== null;
}
