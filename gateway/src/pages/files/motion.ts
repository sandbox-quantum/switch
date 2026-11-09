// The explorer's motion, from the shared explorer spec:
// the same durations and easing as Switch Console. Opacity and a short
// slide or scale only, never on data that isn't loaded, and nothing at all
// when the person asks for reduced motion (every state still shows).

import { keyframes } from "@emotion/react";

export const MOTION = {
  /** Things appearing: list rows, the breadcrumb's new part, the list after waking. */
  inMs: 200,
  /** Things leaving, and the preview closing. */
  outMs: 150,
  easeOut: "cubic-bezier(0.2, 0, 0, 1)",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
  /** How far the list slides on a folder change. */
  slidePx: 12,
  /** The preview's size as it starts to open from the row. */
  previewScale: 0.96,
  /** The waking cloud's slow pulse. */
  pulseMs: 2000,
} as const;

/** The media query that turns every animation here off. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const STILL = { [`@media ${REDUCED_MOTION}`]: { animation: "none" } } as const;

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;
const fromRight = keyframes`
  from { opacity: 0; transform: translateX(${MOTION.slidePx}px); }
  to { opacity: 1; transform: none; }
`;
const fromLeft = keyframes`
  from { opacity: 0; transform: translateX(-${MOTION.slidePx}px); }
  to { opacity: 1; transform: none; }
`;
const pulse = keyframes`
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.04); }
`;

/** Fades in once, as it first appears. */
export const APPEAR_SX = { animation: `${fadeIn} ${MOTION.inMs}ms ${MOTION.easeOut} both`, ...STILL } as const;

/** Which way a folder change went: into a folder, back up, or elsewhere (a fade alone). */
export type Travel = "in" | "up" | "none";

/** The way from one open folder to the next. */
export function travelBetween(from: string | null, to: string): Travel {
  if (from === null || from === to) return "none";
  if (from === "" || to.startsWith(`${from}/`)) return to === "" ? "none" : "in";
  if (to === "" || from.startsWith(`${to}/`)) return "up";
  return "none";
}

/** The arrival animation for each way of travel. */
export const ARRIVALS = { in: fromRight, up: fromLeft, none: fadeIn } as const;

/** The list arriving: a short slide in the direction of travel, from the right going in and the left going up. */
export function arriveSx(travel: Travel) {
  const name = ARRIVALS[travel];
  return { animation: `${name} ${MOTION.inMs}ms ${MOTION.easeOut} both`, ...STILL } as const;
}

/** The waking cloud's slow pulse, still under reduced motion. */
export const PULSE_SX = { animation: `${pulse} ${MOTION.pulseMs}ms ease-in-out infinite`, ...STILL } as const;

/** Where on screen a preview opens from: the clicked row's centre. */
export type Origin = { x: number; y: number };

/** The centre of an element on screen, for the preview to grow from. */
export function centreOf(element: Element | null | undefined): Origin | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/**
 * The preview growing out of its row (0.96 → 1 with a fade, 200 ms) or
 * shrinking back (150 ms). Uses the browser's own animations, so nothing
 * runs where they aren't there (tests) or when motion is reduced.
 */
export function animatePaper(paper: Element | null, origin: Origin | null, opening: boolean, reduced: boolean): void {
  if (!paper || reduced || !(paper instanceof HTMLElement) || typeof paper.animate !== "function") return;
  if (origin) {
    const box = paper.getBoundingClientRect();
    paper.style.transformOrigin = `${origin.x - box.left}px ${origin.y - box.top}px`;
  }
  const small = { transform: `scale(${MOTION.previewScale})`, opacity: 0 };
  const full = { transform: "scale(1)", opacity: 1 };
  paper.animate(opening ? [small, full] : [full, small], {
    duration: opening ? MOTION.inMs : MOTION.outMs,
    easing: opening ? MOTION.easeOut : MOTION.easeIn,
    fill: "both",
  });
}
