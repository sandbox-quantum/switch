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

/** The effects one reveal attempt needs, injected so the rule below can be
 * exercised without a DOM or a layout. */
export interface RevealAttemptIO {
  /** Re-derive the selection and open whatever is hiding it. */
  reveal: () => void;
  /** Whether a row is mid-drag, in which case the viewport is left alone. */
  dragging: () => boolean;
  /** The active row's edges, or null when it is not rendered yet. */
  findRow: () => Edges | null;
  /** The scroll container's edges. */
  scroller: () => Edges;
  scrollBy: (delta: number) => void;
}

/**
 * One attempt at showing the selected row: open whatever hides it, then bring
 * it into view. True once the row exists and has been settled.
 *
 * Revealing is repeated on every attempt rather than done once up front. The
 * room a session belongs to may still be loading when the selection changes —
 * a deeplink scopes to another server and navigates in the same breath — and a
 * reveal computed before that arrives knows of no room to open, so it opens
 * nothing and the row stays hidden for good. Reveals are idempotent, so
 * repeating one costs nothing once it has taken effect.
 */
export function attemptRevealSelection(io: RevealAttemptIO): boolean {
  io.reveal();
  if (io.dragging()) return false;
  const row = io.findRow();
  if (!row) return false;
  const delta = scrollDeltaFor(io.scroller(), row);
  // Instant, never smooth: a glide under a held pointer travels far enough to
  // cross the drag activation distance and turn a click into a drag.
  if (delta !== 0) io.scrollBy(delta);
  return true;
}

export function useScrollSelectionIntoView(scrollerRef: RefObject<HTMLElement | null>): void {
  // Read in render so the sidebar re-renders — and this effect re-runs — the
  // moment the selection changes, wherever it was changed from.
  const selectionKey = currentSelectionKey();
  const settledKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || settledKey.current === selectionKey) return;

    const bringIntoView = (): boolean => {
      const settled = attemptRevealSelection({
        reveal: () => {
          const selection = currentSidebarSelection();
          if (selection) sidebarStore.revealSelection(selection);
        },
        dragging: isSidebarRowDragging,
        findRow: () => activeRowIn(scroller)?.getBoundingClientRect() ?? null,
        scroller: () => scroller.getBoundingClientRect(),
        scrollBy: (delta) => {
          scroller.scrollTop += delta;
        },
      });
      if (settled) settledKey.current = selectionKey;
      return settled;
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
