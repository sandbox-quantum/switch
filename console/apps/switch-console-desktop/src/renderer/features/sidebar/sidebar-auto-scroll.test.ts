import { describe, expect, it, vi } from 'vitest';
import {
  attemptRevealSelection,
  scrollDeltaFor,
  type RevealAttemptIO,
} from './sidebar-auto-scroll';

// The hook this module also exports reaches the app's singletons; the scroll
// rule under test does not.
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {}, sidebarStore: {} }));

const viewport = { top: 100, bottom: 400 };
const MARGIN = 8;

describe('scrollDeltaFor', () => {
  it('leaves a row that is already fully visible alone', () => {
    expect(scrollDeltaFor(viewport, { top: 200, bottom: 232 }, MARGIN)).toBe(0);
  });

  it('leaves a row flush against an edge alone rather than nudging it by the margin', () => {
    expect(scrollDeltaFor(viewport, { top: 100, bottom: 132 }, MARGIN)).toBe(0);
    expect(scrollDeltaFor(viewport, { top: 368, bottom: 400 }, MARGIN)).toBe(0);
  });

  it('scrolls up for a row above the viewport, clearing the margin', () => {
    expect(scrollDeltaFor(viewport, { top: 40, bottom: 72 }, MARGIN)).toBe(-68);
  });

  it('scrolls down for a row below the viewport, clearing the margin', () => {
    expect(scrollDeltaFor(viewport, { top: 500, bottom: 532 }, MARGIN)).toBe(140);
  });

  it('brings a partly-cut row fully into view', () => {
    expect(scrollDeltaFor(viewport, { top: 90, bottom: 122 }, MARGIN)).toBe(-18);
    expect(scrollDeltaFor(viewport, { top: 380, bottom: 412 }, MARGIN)).toBe(20);
  });

  it('aligns a row taller than the viewport to the top instead of chasing it', () => {
    expect(scrollDeltaFor(viewport, { top: 50, bottom: 600 }, MARGIN)).toBe(-58);
  });
});

function io(overrides: Partial<RevealAttemptIO> = {}): RevealAttemptIO {
  return {
    reveal: vi.fn(),
    dragging: () => false,
    findRow: () => ({ top: 200, bottom: 232 }),
    scroller: () => viewport,
    scrollBy: vi.fn(),
    ...overrides,
  };
}

describe('attemptRevealSelection', () => {
  it('settles once the row is rendered', () => {
    const deps = io();

    expect(attemptRevealSelection(deps)).toBe(true);
    expect(deps.reveal).toHaveBeenCalledOnce();
  });

  it('scrolls a row that is out of view', () => {
    const deps = io({ findRow: () => ({ top: 500, bottom: 532 }) });

    attemptRevealSelection(deps);

    expect(deps.scrollBy).toHaveBeenCalledWith(140);
  });

  it('leaves the viewport alone when the row is already visible', () => {
    const deps = io();

    attemptRevealSelection(deps);

    expect(deps.scrollBy).not.toHaveBeenCalled();
  });

  it('reveals again on a later attempt rather than only the first', () => {
    // The room a session belongs to can still be loading when the selection
    // changes — a deeplink scopes to another server and navigates at once — so
    // the first reveal knows of no room and opens nothing. Retrying the reveal
    // alongside the scroll is what eventually opens the group; revealing once
    // up front left the row hidden for good (CHOO-1686).
    const deps = io({ findRow: () => null });

    expect(attemptRevealSelection(deps)).toBe(false);
    expect(attemptRevealSelection(deps)).toBe(false);

    expect(deps.reveal).toHaveBeenCalledTimes(2);
  });

  it('still reveals when the row has not rendered yet', () => {
    // Revealing is what makes it render, so it cannot be conditional on it.
    const deps = io({ findRow: () => null });

    attemptRevealSelection(deps);

    expect(deps.reveal).toHaveBeenCalledOnce();
    expect(deps.scrollBy).not.toHaveBeenCalled();
  });

  it('does not move the viewport out from under a drag', () => {
    const deps = io({ dragging: () => true, findRow: () => ({ top: 500, bottom: 532 }) });

    expect(attemptRevealSelection(deps)).toBe(false);
    expect(deps.scrollBy).not.toHaveBeenCalled();
  });
});
