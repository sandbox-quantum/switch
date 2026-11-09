// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// The explorer's motion, pinned to the shared spec: 200 ms in with ease-out, a
// 12 px slide, the preview growing from 0.96, the waking cloud's slow loop, and
// nothing at all when the person asks for reduced motion.

const reduced = vi.hoisted(() => ({ value: false as boolean | null }));
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useReducedMotion: () => reduced.value,
}));

const {
  EXPLORER_MOTION,
  explorerTransitions,
  previewOrigin,
  slideDirection,
  useExplorerTransitions,
} = await import('./explorer-motion');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('explorer motion', () => {
  it('uses the spec’s timings: 200 ms in, 150 ms out, 12 px, 0.96, a 2 s loop', () => {
    expect(EXPLORER_MOTION).toEqual({
      enterMs: 200,
      exitMs: 150,
      enterEase: [0.2, 0, 0, 1],
      exitEase: [0.4, 0, 1, 1],
      slidePx: 12,
      previewScale: 0.96,
      wakingLoopMs: 2000,
    });
    const normal = explorerTransitions(false);
    expect(normal.enter).toEqual({ duration: 0.2, ease: [0.2, 0, 0, 1] });
    expect(normal.tree).toEqual({ duration: 0.2, ease: [0.2, 0, 0, 1] });
    expect(normal.waking).toMatchObject({ duration: 2, repeat: Infinity });
    expect(normal.slidePx).toBe(12);
    expect(normal.previewScale).toBe(0.96);
  });

  it('every motion lasts between 150 and 250 ms, apart from the one allowed loop', () => {
    const normal = explorerTransitions(false);
    for (const transition of [normal.enter, normal.tree])
      expect((transition as { duration: number }).duration * 1000).toBeGreaterThanOrEqual(150);
    for (const transition of [normal.enter, normal.tree])
      expect((transition as { duration: number }).duration * 1000).toBeLessThanOrEqual(250);
  });

  it('with reduced motion nothing moves: zero durations, no slide, no growing, no loop', () => {
    expect(explorerTransitions(true)).toEqual({
      enter: { duration: 0 },
      tree: { duration: 0 },
      waking: null,
      slidePx: 0,
      previewScale: 1,
    });
  });

  it('follows the person’s own setting', async () => {
    let seen: ReturnType<typeof useExplorerTransitions> | null = null;
    const Probe = () => {
      seen = useExplorerTransitions();
      return null;
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    reduced.value = true;
    await act(async () => root.render(createElement(Probe)));
    expect(seen).toEqual(explorerTransitions(true));
    reduced.value = null; // not known yet: treated as motion allowed
    await act(async () => root.render(createElement(Probe, { key: 'again' })));
    expect(seen).toEqual(explorerTransitions(false));
    await act(async () => root.unmount());
  });

  it('slides in going into a folder, out going up, and only fades for a jump elsewhere', () => {
    expect(slideDirection('', 'shared')).toBe(1);
    expect(slideDirection('shared', 'shared/sample-bakery')).toBe(1);
    expect(slideDirection('shared/sample-bakery', 'shared')).toBe(-1);
    expect(slideDirection('shared/sample-bakery', '')).toBe(-1);
    expect(slideDirection('shared', 'baker')).toBe(0);
    expect(slideDirection('shared', 'shared-old')).toBe(0);
    expect(slideDirection(null, 'shared')).toBe(0);
    expect(slideDirection('shared', 'shared')).toBe(0);
  });

  it('the preview grows from the clicked row’s centre, kept inside the preview, or from its middle', () => {
    const popup = { left: 100, top: 50, width: 800, height: 600 };
    expect(previewOrigin(popup, { x: 300, y: 200 })).toBe('200px 150px');
    expect(previewOrigin(popup, { x: 20, y: 900 })).toBe('0px 600px');
    expect(previewOrigin(popup, null)).toBe('50% 50%');
  });
});
