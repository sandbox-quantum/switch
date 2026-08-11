/**
 * Whether a sidebar row is being dragged to reorder.
 *
 * A plain flag rather than store state: nothing renders from it, it is read
 * once inside a callback, and keeping it free of imports keeps the drag
 * plumbing free of the app's singletons.
 *
 * It exists because dnd-kit measures every droppable when a drag starts.
 * Anything that scrolls the list before the drop desyncs those rects, and the
 * row lands in a slot the user did not aim at.
 */

let dragging = false;

export function setSidebarRowDragging(value: boolean): void {
  dragging = value;
}

export function isSidebarRowDragging(): boolean {
  return dragging;
}
