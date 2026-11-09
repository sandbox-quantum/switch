import { type Transition, useReducedMotion } from 'motion/react';

/**
 * The explorer's motion, from the shared spec: 200 ms in with ease-out, 150 ms
 * out with ease-in, a 12 px slide for folder changes, the preview growing from
 * 0.96. Everything is zero, and every loop stops, when the person asks for
 * reduced motion. Motion only ever plays on rows already loaded.
 */
export const EXPLORER_MOTION = {
  enterMs: 200,
  exitMs: 150,
  /** Ease-out, for things appearing. */
  enterEase: [0.2, 0, 0, 1] as const,
  /** Ease-in, for things leaving. */
  exitEase: [0.4, 0, 1, 1] as const,
  slidePx: 12,
  previewScale: 0.96,
  wakingLoopMs: 2000,
};

export type ExplorerTransitions = {
  /** Things appearing: rows, a breadcrumb part, the list after waking, the preview. */
  enter: Transition;
  /** The tree's height and the chevron's turn. */
  tree: Transition;
  /** The waking cloud's slow pulse; none at all under reduced motion. */
  waking: Transition | null;
  /** How far a folder change slides, in px (0 under reduced motion). */
  slidePx: number;
  /** Where the preview grows from (1 under reduced motion: it just appears). */
  previewScale: number;
};

/** The transitions to use, given whether the person asked for reduced motion. */
export function explorerTransitions(reduced: boolean): ExplorerTransitions {
  if (reduced)
    return {
      enter: { duration: 0 },
      tree: { duration: 0 },
      waking: null,
      slidePx: 0,
      previewScale: 1,
    };
  const seconds = (ms: number) => ms / 1000;
  return {
    enter: { duration: seconds(EXPLORER_MOTION.enterMs), ease: EXPLORER_MOTION.enterEase },
    tree: { duration: seconds(EXPLORER_MOTION.enterMs), ease: EXPLORER_MOTION.enterEase },
    waking: {
      duration: seconds(EXPLORER_MOTION.wakingLoopMs),
      ease: 'easeInOut',
      repeat: Infinity,
      repeatType: 'mirror',
    },
    slidePx: EXPLORER_MOTION.slidePx,
    previewScale: EXPLORER_MOTION.previewScale,
  };
}

/** The explorer's transitions for this person's motion setting. */
export function useExplorerTransitions(): ExplorerTransitions {
  return explorerTransitions(useReducedMotion() ?? false);
}

/**
 * Which way a folder change goes: 1 going into a folder (slides in from the
 * right), -1 going back up (from the left), 0 for anything else (a jump to
 * another branch just fades).
 */
export function slideDirection(from: string | null, to: string): -1 | 0 | 1 {
  if (from === null || from === to) return 0;
  const inside = (outer: string, inner: string) => outer === '' || inner.startsWith(`${outer}/`);
  if (inside(from, to)) return 1;
  if (inside(to, from)) return -1;
  return 0;
}

/**
 * Where the preview grows from: the clicked row's centre, in the preview's own
 * coordinates. With no row (opened by previous or next), it grows from its middle.
 */
export function previewOrigin(
  popup: { left: number; top: number; width: number; height: number },
  row: { x: number; y: number } | null
): string {
  if (!row) return '50% 50%';
  const clamp = (value: number, size: number) => Math.max(0, Math.min(value, size));
  return `${Math.round(clamp(row.x - popup.left, popup.width))}px ${Math.round(clamp(row.y - popup.top, popup.height))}px`;
}
