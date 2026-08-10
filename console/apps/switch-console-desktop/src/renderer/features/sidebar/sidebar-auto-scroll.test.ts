import { describe, expect, it, vi } from 'vitest';
import { scrollDeltaFor } from './sidebar-auto-scroll';

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
