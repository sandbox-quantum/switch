import { useLayoutEffect, useRef, type RefObject } from 'react';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { isSidebarRowDragging } from './sidebar-drag-state';
import { currentSelectionKey, currentSidebarSelection } from './sidebar-selection';

/**
 * Keep the selected sidebar row in view.
 *
 * The tree has one scroll container and every row type marks itself
 * `data-active`, so this is one effect on that container rather than a scroll
 * call per row type — which would have to be repeated for sessions, agents,
 * agents-under-rooms and rooms, and then again for each of the dozen places
 * that can change the selection.
 */

/** Gap left between the row and the edge of the viewport when scrolling it in. */
const SCROLL_MARGIN = 8;

interface Edges {
  top: number;
  bottom: number;
}

/**
 * How far the scroller must move for `row` to sit inside it, in pixels
 * (negative scrolls up). Zero when the row is already fully visible — a row on
 * screen is never nudged, whatever its position.
 *
 * Split out from the effect so the rule is testable without a DOM or a layout.
 */
export function scrollDeltaFor(scroller: Edges, row: Edges, margin = SCROLL_MARGIN): number {
  const above = row.top - scroller.top;
  const below = row.bottom - scroller.bottom;
  if (above >= 0 && below <= 0) return 0;
  // A row taller than the viewport is aligned to the top rather than chased.
  return above < 0 ? above - margin : below + margin;
}

/**
 * The active row to bring into view, or null when none is rendered.
 *
 * A room lists under every agent that has sessions in it, so several rows can
 * be active at once. One already on screen wins: there is no reason to move the
 * viewport to a different copy of what the user can already see.
 */
function activeRowIn(scroller: HTMLElement): HTMLElement | null {
  const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-active]'));
  const scrollerEdges = scroller.getBoundingClientRect();
  for (const row of rows) {
    if (scrollDeltaFor(scrollerEdges, row.getBoundingClientRect()) === 0) return row;
  }
  return rows[0] ?? null;
}

export function useScrollSelectionIntoView(scrollerRef: RefObject<HTMLElement | null>): void {
  // Read in render so the sidebar re-renders — and this effect re-runs — the
  // moment the selection changes, wherever it was changed from.
  const selectionKey = currentSelectionKey();
  const settledKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || settledKey.current === selectionKey) return;

    const selection = currentSidebarSelection();
    if (selection) sidebarStore.revealSelection(selection);

    const bringIntoView = (): boolean => {
      if (isSidebarRowDragging()) return false;
      const row = activeRowIn(scroller);
      if (!row) return false;
      settledKey.current = selectionKey;
      const delta = scrollDeltaFor(scroller.getBoundingClientRect(), row.getBoundingClientRect());
      // Instant, never smooth: a glide under a held pointer travels far enough
      // to cross the drag activation distance and turn a click into a drag.
      if (delta !== 0) scroller.scrollTop += delta;
      return true;
    };

    if (bringIntoView()) return;

    // The row can arrive after the selection does — expanding its group renders
    // it a beat later, and at startup the restored view is set before the tree
    // has loaded. Watch until it shows up, then stop.
    const pending = new MutationObserver(() => {
      if (bringIntoView()) pending.disconnect();
    });
    pending.observe(scroller, { childList: true, subtree: true });
    return () => pending.disconnect();
  }, [selectionKey, scrollerRef]);
}
