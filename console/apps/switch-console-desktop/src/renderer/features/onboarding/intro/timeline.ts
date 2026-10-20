/*
 * Switch console onboarding animation — the beat sheet.
 *
 * Every timing, easing, spring constant, stagger and piece of geometry lives in this file.
 * Retiming the piece means editing numbers here and nowhere else.
 *
 * Spec sources:
 *   ../SwitchOnboarding/session-outputs/intro-animation-plan.md   (motion)
 *   ./session-outputs/build-brief.md                              (geometry)
 *
 * Colour note: the hex values below are Switch / SandboxAQ brand values supplied by the
 * brief. They are NOT in this repo's design systems (Core DS / Hoot) — this is a
 * standalone branded splash, not a product screen, so the raw hex is intentional.
 * Same precedent as src/pages/SwitchOnboarding/SwitchOnboarding.jsx.
 */

import { type AnimationSequence, type MotionValue } from 'motion/react';

/* --------------------------------------------------------------------------- types */

export type AgentKey = 'writer' | 'builder';
export type MessageId = 'lassya' | AgentKey;
export type ThemeName = 'light' | 'dark';
export type ChipIcon = 'Cable' | 'Cpu' | 'Goal' | 'Hand' | 'ShieldCheck';

/** Cubic-bezier control points, [x1, y1, x2, y2]. */
export type CubicBezier = [number, number, number, number];

export interface Chip {
  id: string;
  label: string;
  icon: ChipIcon;
  r: number;
  angle: number;
  jitter: number;
}

export interface Message<Id extends MessageId = MessageId> {
  id: Id;
  author: string;
  lines: string[];
  h: number;
}

export interface MessageRow<Id extends MessageId = MessageId> extends Message<Id> {
  top: number;
  tileCx: number;
  tileCy: number;
}

export interface EjectTarget {
  at: number;
  flight: number;
  fromLeft: number;
  fromTop: number;
  dx: number;
  dy: number;
}

export interface AgentBeat {
  open: number;
  say: number;
  line2?: number;
}

export interface Gaze {
  x: number;
  y: number;
}

export interface EyeState extends Gaze {
  blink: number;
  smile: number;
}

interface Saccade extends Gaze {
  at: number;
}

/* -------------------------------------------------------------------------- colour */

/*
 * Every themeable colour is a CSS custom property, resolved from whichever theme the stage
 * has applied (see THEMES below). Variables rather than a React context for two reasons:
 * the palette is read at module scope across five files, and a theme swap then costs one
 * style write on one element instead of re-rendering a running animation.
 *
 * Three values are deliberately NOT themed. The agents keep their brand colours in both
 * themes — they are the subject of the piece, not chrome — and their eyes stay near-black
 * because they sit on those same pastel bodies either way. All three are also used as SVG
 * presentation ATTRIBUTES, which do not resolve var().
 *
 * The role names are the point: `surface` is "one level above the window", not "white".
 * That separation is what makes a dark theme expressible at all — the old palette used one
 * `white` for the window's top stop, the chip fill AND the message area, three jobs that
 * stay together in light and have to come apart in dark.
 */
export const PALETTE = {
  ink: 'var(--sw-ink)', // the mark's line art, chip labels and chip icons
  border: 'var(--sw-border)', // window border
  desktop: 'var(--sw-desktop)', // the dimmed desktop behind the window
  windowTop: 'var(--sw-window-top)', // window gradient, top stop
  windowBottom: 'var(--sw-window-bottom)', // window gradient, bottom stop
  surface: 'var(--sw-surface)', // chips, message area, controls — one level above the window
  panel: 'var(--sw-panel)', // the shell around the message area
  tile: 'var(--sw-tile)', // avatar tile inside a message row
  channelActive: 'var(--sw-channel-active)',
  chatInk: 'var(--sw-chat-ink)', // chat names / channel labels
  chatBody: 'var(--sw-chat-body)', // chat message body
  chipShadow: 'var(--sw-chip-shadow)',

  writer: '#A1C9D2', // brand — identical in both themes
  builder: '#FF895E',
  eye: '#0F172A',
};

/*
 * The two themes.
 *
 * Light is the original piece, unchanged, with its three `white` jobs split out by role.
 *
 * Dark is built on Fortress Black #1B1817 as the window, and the light theme's own
 * relationships are preserved rather than inverted blindly:
 *
 *   - The window is LIGHTER than the desktop behind it in light (#fdfdfc on #e9e8e4), so it
 *     is lighter than the desktop in dark too (#1B1817 on #0e0c0c) and still reads as a
 *     window sitting on something rather than a hole cut in it.
 *   - The window gradient warms as it falls in light (Clarity White -> Guardian Sand). Dark
 *     warms as it falls as well, #1B1817 -> #241e1c, which also gives the aurora something
 *     to bloom into at the bottom of the frame.
 *   - Light's panel shell is a dark veil over the window; dark's is a light one, same 6%.
 *   - Chat body text drops the same amount of contrast below the names in both.
 *
 * The aurora and the window chrome are assets, not colours, so they are handled with a
 * blend mode and a filter: the aurora's brand stops are pale, so on dark it SCREENS onto
 * the window as emitted light instead of sitting on it as a milky wash, and the wordmark
 * and close glyph — both solid black in the files — invert. The traffic lights are left
 * alone; they are the same three colours on any Mac, on any desktop.
 */
export const THEMES: Record<ThemeName, Record<string, string>> = {
  light: {
    '--sw-ink': '#1B1817', // Fortress Black
    '--sw-border': '#c5c9cf',
    '--sw-desktop': '#e9e8e4',
    '--sw-window-top': '#fdfdfc', // Clarity White
    '--sw-window-bottom': '#f4eee6', // Guardian Sand
    '--sw-surface': '#fdfdfc',
    '--sw-panel': 'rgba(26,26,26,0.06)',
    '--sw-tile': '#ececec',
    '--sw-channel-active': 'rgba(255,255,255,0.5)',
    '--sw-chat-ink': '#1f2328',
    '--sw-chat-body': '#4b5563',
    '--sw-chip-shadow': 'rgba(0,0,0,0.06)',
    '--sw-aurora-blend': 'normal',
    '--sw-aurora-opacity': '1',
    '--sw-chrome-filter': 'none',
  },
  dark: {
    '--sw-ink': '#fdfdfc', // Clarity White — the line art, inverted
    '--sw-border': '#38322f',
    '--sw-desktop': '#0e0c0c',
    '--sw-window-top': '#1B1817', // Fortress Black
    '--sw-window-bottom': '#241e1c',
    '--sw-surface': '#2e2725',
    '--sw-panel': 'rgba(253,253,252,0.06)',
    '--sw-tile': '#3a3230',
    '--sw-channel-active': 'rgba(253,253,252,0.08)',
    // Both brighter than a straight tonal inversion of the light theme would give: against
    // a near-black panel that reads as dim rather than as restraint. The body still sits a
    // step under the names, the same relationship light has.
    '--sw-chat-ink': '#fdfdfc', // names, channel labels
    '--sw-chat-body': '#ddd5ce', // warm off-white, ~10:1 on the message surface
    '--sw-chip-shadow': 'rgba(0,0,0,0.45)', // a shadow has to work harder on a dark surface
    '--sw-aurora-blend': 'screen',
    '--sw-aurora-opacity': '0.55',
    '--sw-chrome-filter': 'invert(1)',
  },
};

export const THEME_NAMES: ThemeName[] = ['light', 'dark'];

/* --------------------------------------------------------------------------- stage */

export const STAGE = { w: 1440, h: 900 };

/* ---------------------------------------------------------------------------- mark */

// 124x124 mark, centred at stage (729, 450) — 9px right of stage centre, matching aurora.
export const MARK = { size: 124, cx: 729, cy: 450, left: 667, top: 388 };

/*
 * The original THICK logo's bar interiors. The agents' rest positions still hang off these
 * (that is just where they sit inside the pod), but nothing is CROPPED against them any
 * more — the crop is the finished line drawing's interior, see MARK_CLIP.
 */
const BAR_TOP = 55.3027; // bottom edge of the upper bar
const BAR_BOTTOM = 68.6985; // top edge of the lower bar
const BAR_LOWER_BOTTOM = 110.604; // bottom edge of the lower bar

// Toss travel, from the Figma frames: rest centre y 450 -> apex 197 -> landed 349.
/*
 * The toss. `landed` carries the mark fully UNDER the chat panel — it disappears by
 * occlusion, never by fading. The only opaque thing on the stage is the white message panel
 * (x 599..1035, y 342..558); the outer panel is rgba(26,26,26,0.06) and hides nothing.
 *
 * At rest the mark is still stretched to scaleY 1.14 from the fall, so the test is against
 * the stretched box: MARK.cy + landed ± 62 * 1.14 must sit inside 342..558. That caps
 * `landed` at +37; +30 clears the bottom edge by 7.3 units.
 */
export const TOSS = { apex: -253, landed: 30 };

/* -------------------------------------------------------------------------- agents */

/*
 * Each avatar is a 512x512 viewBox whose visible shape is centred in the box. We size the
 * box so the shape reads SHAPE_W wide, then place the shape centre inside the slot.
 *
 * Shape centre x matches the mark's own indicator pips — upper-right for the writer,
 * lower-left for the builder — so the agents are literally born where the pips sit.
 *
 * Rest y = slotBottom - 0.45 * shapeHeight (peeking out, bottom edge cut by the slot).
 */
/*
 * Avatar size and rest position. Judge these against the RUNNING BUILD, not against a mock.
 *
 *   SHAPE_W   the agent's visible width, in mark units
 *   REST_CLIP where the shape's centre sits above its bar's bottom edge, as a fraction of
 *             its own height
 *
 * These are deliberately separate from the crop below: the crop is the interior of the
 * finished line drawing and is fixed by the logo, while these two decide how much of that
 * interior the agent actually fills.
 */
const SHAPE_W = 64;
const REST_CLIP = 0.36;

function avatarShape(nativeW: number, nativeH: number, cx: number, barBottom: number) {
  const scale = SHAPE_W / nativeW;
  const box = 512 * scale;
  const h = nativeH * scale;
  const cy = barBottom - REST_CLIP * h;
  return {
    scale,
    box,
    shapeW: SHAPE_W,
    shapeH: h,
    cx,
    cy,
    left: cx - box / 2,
    top: cy - box / 2,
    ejectScale: 26 / SHAPE_W, // lands as a 26px glyph inside the 40px chat tile
  };
}

export const AVATARS = {
  // writer: pill, native 391x253 inside the 512 box
  writer: {
    ...avatarShape(391, 253, 78, BAR_TOP),
    body: PALETTE.writer,
    // power-up bloom, in the agent's own colour. The far stop is the same hue at zero alpha,
    // not `transparent` — `transparent` is rgba(0,0,0,0) and fringes the bloom grey.
    glow: 'radial-gradient(circle, rgba(161,201,210,1) 0%, rgba(161,201,210,0) 70%)',
  },
  // builder: diamond, native 379x379 inside the 512 box
  builder: {
    ...avatarShape(379, 379, 46, BAR_LOWER_BOTTOM),
    body: PALETTE.builder,
    glow: 'radial-gradient(circle, rgba(255,137,94,1) 0%, rgba(255,137,94,0) 70%)',
  },
};

/*
 * The hollow-out thickness. T = 13.3958 is the logo's real ring thickness, so ring (stroked
 * at 2T, clipped to the outer path) + divider (width T, centred on the real gap band)
 * reconstructs the mark exactly; T = 1 is the finished line drawing.
 */
export const MARK_T = {
  from: 13.3958,
  to: 1,
  dividerY: (BAR_TOP + BAR_BOTTOM) / 2,
  at: 0.95,
  duration: 0.4,
  // front-loaded: most of the thinning happens early, then it settles into the line
  ease: [0.33, 1, 0.68, 1] satisfies CubicBezier,
};

/*
 * Where the agents are cropped. NOT the original thick logo's bar rects — those sit a full
 * ring thickness inside the finished artwork, which left a 6.2-unit dead gap above the
 * divider and 13.4 on every outer edge, so the agents floated inside the pod instead of
 * touching it.
 *
 * The crop is the interior of the LINE DRAWING: the outer silhouette, split by the two edges
 * of the 1px divider. Derived from the divider position and the final line weight so that if
 * the line weight ever changes the crop follows it.
 *
 * It is deliberately static — the agents arrive at the tail of the morph, and the slots now
 * render UNDER the mark's artwork, so the thick ring correctly covers them while it is still
 * thick, and the 1px lines draw over their cut edges afterwards. A sub-pixel crop error
 * becomes invisible rather than becoming a gap.
 */
export const MARK_CLIP = {
  upper: MARK_T.dividerY - MARK_T.to / 2,
  lower: MARK_T.dividerY + MARK_T.to / 2,
};

// Weightless float — contents of a falling container drift to the ceiling.
export const FLOAT_Y = -7;

/* --------------------------------------------------------------------------- chips */

/*
 * Hand-placed centres from Figma frame 5, expressed polar about the mark centre.
 * Each chip KEEPS ITS OWN RADIUS — a uniform ring flattens the composition. The orbit is a
 * single rotation applied to the whole ring, so the irregular shape is preserved.
 *
 * Angles are screen-space (y down): pos = centre + r * (cos t, sin t).
 */
export const CHIPS: Chip[] = [
  { id: 'models', label: 'Models', icon: 'Cpu', r: 190, angle: 222.2, jitter: 6 },
  { id: 'guardrails', label: 'Guardrails', icon: 'ShieldCheck', r: 196, angle: 166.0, jitter: -5 },
  { id: 'instructions', label: 'Instructions', icon: 'Goal', r: 195, angle: 118.6, jitter: 4 },
  { id: 'permissions', label: 'Permissions', icon: 'Hand', r: 238, angle: 42.4, jitter: -6 },
  { id: 'connections', label: 'Connections', icon: 'Cable', r: 208, angle: -25.2, jitter: 5 },
];

// Two DIFFERENT fixed shuffles. Never Math.random() — the demo must play identically every run.
export const POP_ORDER = [1, 4, 2, 0, 3]; // Guardrails, Connections, Instructions, Models, Permissions
export const ABSORB_ORDER = [2, 3, 0, 1, 4]; // Instructions, Permissions, Models, Guardrails, Connections

// The ring is already turning before the first chip appears, so each chip pops into a
// frame that is already in motion rather than sitting still and then starting.
export const ORBIT = { start: 1.65, rate: 24, end: 4.34 }; // deg/s
export const ORBIT_TOTAL = ORBIT.rate * (ORBIT.end - ORBIT.start); // 39.36deg

export const POP = { start: 1.95, stagger: 0.17 }; // slower stagger: each chip reads on arrival
export const ABSORB = { start: 3.2, stagger: 0.21, duration: 0.3 };

export function absorbAt(k: number): number {
  return ABSORB.start + k * ABSORB.stagger;
}

/* ---------------------------------------------------------------------- chat panel */

// Outer shell 646x232, dead centre of the stage. Rises from centre y 566 (+116).
export const PANEL = {
  w: 646,
  h: 232,
  left: 397,
  top: 334,
  riseY: 116,
  pad: 8,
  gap: 8,
  sidebarW: 186,
  messageW: 436,
  messagePad: 16,
};

export const PANEL_INNER = {
  left: PANEL.left + PANEL.pad, // 405
  top: PANEL.top + PANEL.pad, // 342
  h: PANEL.h - PANEL.pad * 2, // 216
};

export const MESSAGE_AREA = {
  left: PANEL_INNER.left + PANEL.sidebarW + PANEL.gap + PANEL.messagePad, // 615
  top: PANEL_INNER.top + PANEL.messagePad, // 358
  w: PANEL.messageW - PANEL.messagePad * 2, // 404
  h: PANEL_INNER.h - PANEL.messagePad * 2, // 184
};

export const CHANNELS = [
  '#product-launch',
  '#switch-ux-improvements',
  '#customer-support',
  '#weekly-report',
];

/*
 * Message rows sit at their final positions in one stack container; the push-up is a single
 * `y` on that container, clipped by the message area. Bottom-anchoring falls straight out of
 * it — a row that hasn't arrived yet is simply below the clip:
 *
 *   stackY | lassya | writer | builder   (message area is 358..542)
 *      130 |  500 ok|  554 cut|  630 cut
 *       54 |  424 ok|  478 ok |  554 cut
 *        0 |  370 ok|  424 ok |  500 ok
 *
 * Transform-only, no height or layout change anywhere in the piece.
 *
 * Row heights: 40px avatar tile, or name(20) + body lines(22 each), whichever is taller.
 */
const ROW_GAP = 12;
export const MESSAGES: [Message<'lassya'>, Message<'writer'>, Message<'builder'>] = [
  // Lassya's body is rendered inline in ChatPanel because of the @mention pills.
  { id: 'lassya', author: 'Lassya', lines: [], h: 42 },
  {
    id: 'writer',
    author: 'writer',
    lines: ["I'm here!", 'Read the docs, got all the tools'],
    h: 64,
  },
  { id: 'builder', author: 'builder', lines: ['Yup. Ready to go!'], h: 42 },
];

const STACK_H = MESSAGES.reduce((n, m) => n + m.h, 0) + ROW_GAP * (MESSAGES.length - 1); // 172
export const STACK_TOP = MESSAGE_AREA.top + MESSAGE_AREA.h - STACK_H; // bottom-anchored

function placeRow<Id extends MessageId>(m: Message<Id>, i: number): MessageRow<Id> {
  const top = STACK_TOP + MESSAGES.slice(0, i).reduce((n, p) => n + p.h + ROW_GAP, 0);
  return { ...m, top, tileCx: MESSAGE_AREA.left + 20, tileCy: top + 20 };
}

export const ROWS: [MessageRow<'lassya'>, MessageRow<'writer'>, MessageRow<'builder'>] = [
  placeRow(MESSAGES[0], 0),
  placeRow(MESSAGES[1], 1),
  placeRow(MESSAGES[2], 2),
];

/*
 * Both agent rows now open on the same beat — the mark plunges in and the agents come
 * straight back out like droplets off the splash — so the stack only has two states.
 * The three-state derivation above still holds; the 54 step is simply never used.
 */
export const STACK_Y = { closed: 130, open: 0 };

/* ------------------------------------------------- the plunge and the surface break */

export const FALL = { at: 5.84, duration: 0.22 };
export const FALL_EASE: CubicBezier = [0.55, 0, 1, 1]; // hard acceleration — a plunge, not a descent
export const FALL_STRETCH = 1.14;
export const FALL_SQUEEZE = 0.92;

/*
 * The surface glow on entry — the agents' power-up bloom applied to the whole messaging UI,
 * much more restrained. Blue and orange offset from each other so the panel briefly carries
 * the colour of both agents that just came out of it.
 *
 * Each stop fades to its own hue at zero alpha; `transparent` is rgba(0,0,0,0) and fringes grey.
 */
export const PANEL_GLOW = {
  bleed: 44, // how far past the panel the halo extends
  blur: 30,
  peak: 0.34, // deliberately low — a tint, not a flash
  duration: 0.78,
  background:
    'radial-gradient(62% 82% at 32% 38%, rgba(161,201,210,0.95) 0%, rgba(161,201,210,0) 72%), ' +
    'radial-gradient(62% 82% at 70% 64%, rgba(255,137,94,0.95) 0%, rgba(255,137,94,0) 72%)',
};

/** Solve a cubic-bezier easing for the normalized TIME at which it reaches `value`. */
function easeTimeAt([x1, y1, x2, y2]: CubicBezier, value: number): number {
  const bez = (a: number, b: number, u: number): number =>
    3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u ** 2 * b + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 50; i += 1) {
    const mid = (lo + hi) / 2;
    if (bez(y1, y2, mid) < value) lo = mid;
    else hi = mid;
  }
  return bez(x1, x2, (lo + hi) / 2);
}

// Fraction of the fall's DISTANCE at which the mark's visual top meets the panel's top edge.
// The mark is stretching as it falls, so its own scale is part of the crossing.
const SURFACE_D =
  (PANEL.top - (MARK.cy + TOSS.apex - MARK.size / 2)) /
  (TOSS.landed - TOSS.apex - (MARK.size / 2) * (FALL_STRETCH - 1));

/*
 * The surface break: the frame the mark enters the water. Worth knowing that this is 73% of
 * the fall's DISTANCE but 85% of its DURATION — the fall ease is hard-accelerating, so the
 * last stretch of travel costs almost no time and the mark is fully under ~30ms after the
 * agents are thrown off it.
 */
export const SURFACE = FALL.at + FALL.duration * easeTimeAt(FALL_EASE, SURFACE_D);

/* ------------------------------------------------------------------- eject geometry */

/*
 * The splash. Each agent breaks back out of the water on ITS OWN frame rather than on the
 * mark's: the builder sits 52px lower inside the mark, so it goes under first and comes
 * back out first, and each one surfaces at the panel's top edge instead of climbing all the
 * way up from wherever the mark happened to be when its roof went under.
 *
 * The plunge is hard-accelerating, though, so the builder's head start is only 29ms — far
 * too close to read as two events. The writer therefore holds under a beat longer, which
 * widens the gap to something the eye can actually count. Everything after the writer's
 * entrance is shifted by the same hold, so the dialogue keeps its own spacing.
 */
export const SPLASH = {
  submerge: 8, // how far past the top edge the agent's centre is when it breaks back out
  rise: 58, // how high above the edge the droplet peaks
  gravity: 3200, // px/s^2 — one world, so both droplets fall under the same g
  hold: { builder: 0, writer: 0.13 },
};

/*
 * Real ballistics, because anything else shows.
 *
 * The flight used to be a spring on x against a three-keyframe arc on y. Those are two
 * independent motions: the spring settled in ~0.3s while the arc was still climbing, so the
 * horizontal was spent before the fall began and the path read as straight up, pause,
 * straight down. A projectile is not two motions — it is ONE launch velocity and gravity.
 *
 * So: x runs at a constant rate for the whole flight, y is `-v0*t + g*t^2/2` sampled as a
 * dense polyline, and the two compose into the parabola. Both agents launch at the same
 * speed from the same splash and fall under the same g, so the builder — which has further
 * to drop to its row — is genuinely in the air longer. Nothing about the shape is authored;
 * the only design inputs are how high it pops and how hard gravity pulls.
 */
const APEX_H = SPLASH.rise + SPLASH.submerge; // apex height above the launch point
const LAUNCH_V = Math.sqrt(2 * SPLASH.gravity * APEX_H); // up is negative on screen

/** How long this droplet is in the air, given how far below the launch it comes down. */
function flightTime(dy: number): number {
  const g = SPLASH.gravity;
  return (LAUNCH_V + Math.sqrt(LAUNCH_V * LAUNCH_V + 2 * g * dy)) / g;
}

// Linear interpolation between keyframes is a chord across the parabola; at this density the
// worst-case sag is well under a pixel, so the polyline IS the curve.
const BALLISTIC_STEPS = 16;

/** The y track for one flight, as keyframes + their normalized times. */
export function ballistic(e: EjectTarget): { ys: number[]; times: number[] } {
  const ys: number[] = [];
  const times: number[] = [];
  for (let i = 0; i <= BALLISTIC_STEPS; i += 1) {
    const p = i / BALLISTIC_STEPS;
    const t = p * e.flight;
    ys.push(-LAUNCH_V * t + (SPLASH.gravity / 2) * t * t);
    times.push(p);
  }
  ys[ys.length - 1] = e.dy; // land exactly on the tile rather than within rounding of it
  return { ys, times };
}

/*
 * The fall progress at which an agent's centre passes `SPLASH.submerge` below the panel's
 * top edge. The agent's screen position is linear in the progress — the mark's displacement
 * and its stretch are both linear — so this inverts directly instead of being solved for.
 */
function submergeD(key: AgentKey): number {
  const a = AVATARS[key];
  const offset = a.cy - MARK.size / 2; // the agent's centre, in mark units from mark centre
  const at0 = MARK.cy + TOSS.apex + offset;
  const perD = TOSS.landed - TOSS.apex + offset * (FALL_STRETCH - 1);
  return (PANEL.top + SPLASH.submerge - at0) / perD;
}

/*
 * An agent flies to the position its row tile *settles* at, not to a moving target. The
 * stack spring and the two flights run together, so there is a little drift mid-flight —
 * that reads as the agent homing in.
 */
function ejectTarget(key: AgentKey, rowIndex: number): EjectTarget {
  const a = AVATARS[key];
  const half = MARK.size / 2;
  // measured at this agent's own break, through the mark's live displacement and stretch
  const d = submergeD(key);
  const fromX = MARK.cx + (a.cx - half) * (1 - (1 - FALL_SQUEEZE) * d);
  const fromY =
    MARK.cy +
    TOSS.apex +
    (TOSS.landed - TOSS.apex) * d +
    (a.cy - half) * (1 + (FALL_STRETCH - 1) * d);
  const row = ROWS[rowIndex];
  /*
   * The stack opens fully on impact, so both agents fly to a tile that is already at its
   * final resting place: writer 444, builder 520, both inside the 358..542 clip.
   *
   * The flight itself is a projectile — see `ballistic` above. All this has to supply is
   * where it starts, where it comes down, and how long it is in the air.
   */
  const dy = row.tileCy + STACK_Y.open - fromY;
  return {
    at: FALL.at + FALL.duration * easeTimeAt(FALL_EASE, d) + SPLASH.hold[key],
    flight: flightTime(dy),
    fromLeft: fromX - a.box / 2,
    fromTop: fromY - a.box / 2,
    dx: row.tileCx - fromX,
    dy,
  };
}

// builder first — it is the lower of the two inside the mark, so it goes under first
export const EJECT: Record<AgentKey, EjectTarget> = {
  builder: ejectTarget('builder', 2),
  writer: ejectTarget('writer', 1),
};

/* ------------------------------------------------------------------------ the clock */

/*
 * Everything from here is hung off the moment the writer's droplet lands rather than on
 * absolute beats, so retiming the splash — its hold, its arc — carries the dialogue and the
 * running time with it instead of squeezing them against the landings.
 */
const LANDED = EJECT.writer.at + EJECT.writer.flight;

export const SETTLE = LANDED + 0.96;
export const DURATION = SETTLE + 0.35;

/*
 * The tail, as a plunge into a pool. The mark breaks the panel's top edge and keeps going
 * until it is gone under opaque white — it never fades. The two agents are the droplets
 * thrown off at the moment of the break, not at the bottom of the fall, and a ripple spreads
 * outward from the point of entry. Lassya's message lands on the break; both rows open at
 * once; each agent speaks as it lands.
 *
 * No typing indicators — the avatar arriving is the arrival signal, and dots after it are a
 * slower second beat saying the same thing.
 */

// The gaps between the lines are the ones the piece was tuned with.
export const TAIL: Record<AgentKey, AgentBeat> & {
  lassya: number;
  stack: number;
  settle: number;
} = {
  lassya: SURFACE,
  stack: SURFACE + 0.05,
  writer: { open: EJECT.writer.at, say: LANDED + 0.1, line2: LANDED + 0.22 },
  builder: { open: EJECT.builder.at, say: LANDED + 0.34 },
  settle: SETTLE,
};

/* ------------------------------------------------------------------- the beat sheet */

const LAUNCH_EASE: CubicBezier = [0.12, 0.72, 0.3, 1];

/**
 * The whole piece as one framer-motion sequence. Every segment carries an absolute `at:`
 * offset, so the array reads top-to-bottom as the beat sheet and nothing is order-dependent.
 *
 * @param clock seconds elapsed, drives the eyes
 */
export function buildSequence(clock: MotionValue<number>): AnimationSequence {
  const seq: AnimationSequence = [];

  // Master clock — one linear ramp so the eye system and the sequence share a single
  // playback head.
  seq.push([clock, [0, DURATION], { duration: DURATION, ease: 'linear', at: 0 }]);

  /* --- Act 1: the mark (0.00 - 1.65) ------------------------------------------- */

  // Springs carry their own overshoot and their own duration. framer-motion only honours a
  // spring on a two-keyframe segment, and a `duration` alongside stiffness/damping silently
  // switches it to a duration-based spring — so spring beats are always [from, to] with no
  // duration, and opacity rides alongside as its own plain tween.
  seq.push([
    '.mark-body',
    { scale: [0.82, 1] },
    { at: 0.15, type: 'spring', stiffness: 420, damping: 26 },
  ]);
  seq.push(['.mark-body', { opacity: [0, 1] }, { at: 0.15, duration: 0.18, ease: 'easeOut' }]);

  /*
   * Hollow-out: a real thinning, not an outline of the original. One thickness drives both
   * halves of the rig — the outer ring is stroked at 2T and clipped to itself so exactly T
   * shows inward, and the divider is a line of width T across the gap band.
   */
  seq.push([
    '.mark-ring',
    { strokeWidth: [MARK_T.from * 2, MARK_T.to * 2] },
    { at: MARK_T.at, duration: MARK_T.duration, ease: MARK_T.ease },
  ]);
  seq.push([
    '.mark-divider',
    { strokeWidth: [MARK_T.from, MARK_T.to] },
    { at: MARK_T.at, duration: MARK_T.duration, ease: MARK_T.ease },
  ]);
  // The exact filled logo hands over to the rig in the first 120ms, while it is still thick.
  // The rig is opaque from the start and sits UNDERNEATH, so only the top layer fades: the
  // composite stays 100% black throughout instead of dipping to ~75% mid-crossfade. All the
  // fade actually reconciles is the inner corner radii, which is the one place they differ.
  seq.push(['.mark-solid', { opacity: [1, 0] }, { at: MARK_T.at, duration: 0.12 }]);
  // the pips shrink into themselves across the last 40% — gone by the line state
  seq.push([
    '.mark-pip',
    { scale: [1, 0], opacity: [1, 0] },
    { at: MARK_T.at + MARK_T.duration * 0.6, duration: MARK_T.duration * 0.4, ease: 'easeIn' },
  ]);

  seq.push([
    '.mark-body',
    { scale: [1, 1.07] },
    { at: MARK_T.at, duration: MARK_T.duration, ease: 'easeOut' },
  ]);
  seq.push([
    '.mark-body',
    { scale: [1.07, 1] },
    { at: MARK_T.at + MARK_T.duration, type: 'spring', stiffness: 380, damping: 28 },
  ]);

  /* --- Act 2: the agents (1.22 - 2.10), overlapping the tail of the morph ------ */

  (
    [
      ['.agent-writer', 1.22],
      ['.agent-builder', 1.39],
    ] as const
  ).forEach(([sel, at]) => {
    seq.push([
      sel,
      { y: [18, 0], scale: [0.4, 1] },
      { at, type: 'spring', stiffness: 500, damping: 17 },
    ]);
    seq.push([sel, { opacity: [0, 1] }, { at, duration: 0.16, ease: 'easeOut' }]);
  });

  /* --- Act 3: capabilities (1.65 - 4.34) --------------------------------------- */

  POP_ORDER.forEach((chipIndex, k) => {
    const chip = CHIPS[chipIndex];
    const at = POP.start + k * POP.stagger;
    seq.push([
      `.chip-${chip.id}`,
      { scale: [0, 1], rotate: [chip.jitter, 0] },
      { at, type: 'spring', stiffness: 520, damping: 16 },
    ]);
    seq.push([`.chip-${chip.id}`, { opacity: [0, 1] }, { at, duration: 0.14, ease: 'easeOut' }]);
  });

  // Orbit: a shared rotation on the ring container. Chips counter-rotate so labels stay upright.
  const orbitDur = ORBIT.end - ORBIT.start;
  seq.push([
    '.chip-orbit',
    { rotate: [0, ORBIT_TOTAL] },
    { at: ORBIT.start, duration: orbitDur, ease: 'linear' },
  ]);
  CHIPS.forEach((chip) => {
    seq.push([
      `.chip-counter-${chip.id}`,
      { rotate: [0, -ORBIT_TOTAL] },
      { at: ORBIT.start, duration: orbitDur, ease: 'linear' },
    ]);
  });

  // Spiral absorption — a different fixed order. The chip translates toward the ring centre
  // in the ring's own (rotating) frame, so the orbit bends the straight pull into a spiral.
  ABSORB_ORDER.forEach((chipIndex, k) => {
    const chip = CHIPS[chipIndex];
    const at = absorbAt(k);
    const rad = (chip.angle * Math.PI) / 180;
    seq.push([
      `.chip-${chip.id}`,
      {
        x: [0, -chip.r * Math.cos(rad)],
        y: [0, -chip.r * Math.sin(rad)],
        scale: [1, 0.25],
      },
      { at, duration: ABSORB.duration, ease: 'easeIn' },
    ]);
    seq.push([
      `.chip-${chip.id}`,
      { opacity: [1, 0] },
      { at: at + ABSORB.duration - 0.12, duration: 0.12, ease: 'linear' },
    ]);

    // Power-up: each agent blooms in its own colour, plus a mark pulse and an agent pop.
    // The opacity track opens on 0 on purpose — a sequence track holds its FIRST keyframe
    // from t=0, so anything that opens non-zero is parked on screen before the piece starts.
    const hit = at + ABSORB.duration - 0.04;
    (['writer', 'builder'] as const).forEach((agent) => {
      seq.push([
        `.glow-${agent}-${k}`,
        { opacity: [0, 0.85, 0], scale: [0.8, 1.1, 1.35] },
        { at: hit, duration: 0.45, times: [0, 0.3, 1], ease: 'easeOut' },
      ]);
    });
    seq.push(['.mark-body', { scale: [1, 1.05, 1] }, { at: hit, duration: 0.18 }]);
    ['.agent-writer', '.agent-builder'].forEach((sel, i) => {
      seq.push([
        sel,
        { scale: [1, 1.14, 1], rotate: [0, i === 0 ? 3 : -3, 0] },
        { at: hit, duration: 0.26 },
      ]);
    });
  });

  /* --- Act 4: the toss (5.00 - 6.06) ------------------------------------------- */

  // anticipation / squash
  seq.push([
    '.mark-body',
    { scaleY: [1, 0.8], scaleX: [1, 1.18] },
    { at: 5.0, duration: 0.16, ease: 'easeOut' },
  ]);
  seq.push(['.mark-layer', { y: [0, 10] }, { at: 5.0, duration: 0.16, ease: 'easeOut' }]);
  ['.agent-writer', '.agent-builder'].forEach((sel) => {
    seq.push([sel, { scaleY: [1, 0.86], scaleX: [1, 1.1] }, { at: 5.0, duration: 0.16 }]);
  });

  // launch / stretch
  seq.push([
    '.mark-body',
    { scaleY: [0.8, 1.22], scaleX: [1.18, 0.88] },
    { at: 5.16, duration: 0.42, ease: LAUNCH_EASE },
  ]);
  seq.push([
    '.mark-layer',
    { y: [10, TOSS.apex] },
    { at: 5.16, duration: 0.42, ease: LAUNCH_EASE },
  ]);
  ['.agent-writer', '.agent-builder'].forEach((sel) => {
    seq.push([sel, { scaleY: [0.86, 1], scaleX: [1.1, 1] }, { at: 5.16, duration: 0.42 }]);
  });

  // apex hang / weightless — the avatars float up and kiss their slot ceilings
  seq.push([
    '.mark-body',
    { scaleY: [1.22, 1], scaleX: [0.88, 1] },
    { at: 5.58, type: 'spring', stiffness: 220, damping: 22 },
  ]);
  ['.agent-writer', '.agent-builder'].forEach((sel) => {
    seq.push([
      sel,
      { y: [0, FLOAT_Y, FLOAT_Y + 1] },
      { at: 5.58, duration: 0.26, times: [0, 0.85, 1], ease: 'easeOut' },
    ]);
  });

  // fall
  seq.push([
    '.mark-layer',
    { y: [TOSS.apex, TOSS.landed] },
    { at: FALL.at, duration: FALL.duration, ease: FALL_EASE },
  ]);
  seq.push([
    '.mark-body',
    { scaleY: [1, FALL_STRETCH], scaleX: [1, FALL_SQUEEZE] },
    { at: FALL.at, duration: FALL.duration, ease: FALL_EASE },
  ]);

  /*
   * No impact squash on the mark. By the time it lands it is entirely under opaque white, so
   * anything it does down there is invisible — that energy goes to the surface it hit
   * instead, as the ripple below. And it gets no exit animation at all: it is simply gone,
   * because something opaque is in front of it.
   */

  /* --- chat panel arrival (5.45 - 6.02), staggered against the toss ------------ */

  seq.push([
    '.chat-panel',
    { y: [PANEL.riseY, 0], opacity: [0, 1] },
    { at: 5.45, duration: 0.52, ease: 'easeOut' },
  ]);
  CHANNELS.forEach((_, i) => {
    seq.push([
      `.channel-${i}`,
      { y: [8, 0], opacity: [0, 1] },
      { at: 5.78 + i * 0.055, duration: 0.24, ease: 'easeOut' },
    ]);
  });
  seq.push([
    '.channel-active-bg',
    { opacity: [0, 1] },
    { at: 6.0, duration: 0.18, ease: 'easeOut' },
  ]);

  /* --- Acts 5 + 6: the plunge and the splash (6.03 - 6.97) --------------------- */

  /*
   * The mark plunges in and the agents come straight back out of it, like droplets off the
   * splash. Lassya's message is already landing on the impact frame; both rows open on one
   * spring; both agents eject 100ms apart and overlap heavily in flight; each speaks as it
   * lands. Nothing waits for the beat before it.
   */

  // Lassya lands with the impact. Her row is the only one in view, so it sits at the bottom.
  seq.push([
    '.msg-lassya',
    { y: [14, 0], opacity: [0, 1] },
    { at: TAIL.lassya, duration: 0.24, ease: 'easeOut' },
  ]);
  seq.push([
    '.mention-writer',
    { backgroundColor: ['rgba(161,201,210,0)', 'rgba(161,201,210,0.4)'] },
    { at: TAIL.lassya + 0.12, duration: 0.12 },
  ]);
  seq.push([
    '.mention-builder',
    { backgroundColor: ['rgba(255,137,94,0)', 'rgba(255,137,94,0.34)'] },
    { at: TAIL.lassya + 0.21, duration: 0.12 },
  ]);

  // Both rows open at once — one spring on the whole stack. This is what gives both agents
  // a real target at impact time: at stackY 0 the tiles rest at 444 and 520, both inside
  // the 358..542 clip, so neither flies at a row that is still below the fold.
  seq.push([
    '.msg-stack',
    { y: [STACK_Y.closed, STACK_Y.open] },
    { at: TAIL.stack, type: 'spring', stiffness: 380, damping: 30 },
  ]);

  (['writer', 'builder'] as const).forEach((key) => {
    const beat = TAIL[key];
    const e = EJECT[key];
    const arc = ballistic(e);
    // The hand-off is the landing frame itself — the clone touches the tile and the row's
    // own avatar takes over on the same pixels. Never after the agent has spoken, though:
    // a glyph arriving late reads as a bug.
    const land = Math.min(beat.open + e.flight, beat.say - 0.01);

    // The agent climbs out of the logo. Same pixels, same frame: the clipped in-slot agent
    // hands off to the free-flying clone.
    seq.push([`.agent-${key}`, { opacity: [1, 0] }, { at: beat.open, duration: 0.001 }]);
    seq.push([`.eject-${key}`, { opacity: [0, 1] }, { at: beat.open, duration: 0.001 }]);
    // Horizontal velocity is constant — that is what makes the path a parabola rather than
    // two moves that happen to overlap. No spring: a spring has its own acceleration curve,
    // and gravity is already the only acceleration in this flight.
    seq.push([
      `.eject-${key}`,
      { x: [0, e.dx] },
      { at: beat.open, duration: e.flight, ease: 'linear' },
    ]);
    seq.push([
      `.eject-${key}`,
      { y: arc.ys },
      { at: beat.open, duration: e.flight, times: arc.times, ease: 'linear' },
    ]);
    seq.push([
      `.eject-${key}`,
      { scale: [1, AVATARS[key].ejectScale * 1.12, AVATARS[key].ejectScale] },
      { at: beat.open, duration: e.flight, times: [0, 0.86, 1], ease: 'easeOut' },
    ]);

    // the tile arrives with the row, so the agent lands on something
    seq.push([
      `.tile-${key}`,
      { opacity: [0, 1] },
      { at: TAIL.stack, duration: 0.2, ease: 'easeOut' },
    ]);

    // Landed. Swap the free-flying clone for the row's own avatar, so from here the agent
    // belongs to the stack rather than floating over it.
    seq.push([`.eject-${key}`, { opacity: [1, 0] }, { at: land, duration: 0.001 }]);
    seq.push([`.rowavatar-${key}`, { opacity: [0, 1] }, { at: land, duration: 0.001 }]);

    // speech, on landing — no typing indicator; the avatar arriving is the arrival signal
    seq.push([
      `.msg-${key}-0`,
      { y: [14, 0], opacity: [0, 1] },
      { at: beat.say, duration: 0.24, ease: 'easeOut' },
    ]);
    if (beat.line2) {
      seq.push([
        `.msg-${key}-1`,
        { y: [14, 0], opacity: [0, 1] },
        { at: beat.line2, duration: 0.24, ease: 'easeOut' },
      ]);
    }
  });

  /*
   * The surface glows where it was hit: one soft bloom across the whole panel in both agent
   * colours. No rings — Max asked for the power-up glow, scaled up and dialled down.
   *
   * The opacity track opens on 0 on purpose: a framer-motion sequence holds a track's FIRST
   * keyframe from t=0, not the element's inline style, so a non-zero opening value would park
   * a visible wash on screen before the piece begins.
   */
  seq.push([
    '.panel-glow',
    { opacity: [0, PANEL_GLOW.peak, 0] },
    { at: SURFACE, duration: PANEL_GLOW.duration, times: [0, 0.18, 1], ease: 'easeOut' },
  ]);
  seq.push([
    '.panel-glow',
    { scale: [0.98, 1.04] },
    { at: SURFACE, duration: PANEL_GLOW.duration, ease: 'easeOut' },
  ]);

  return seq;
}

/* ============================================================================ eyes ==
 *
 * Saccades and blinks are seeded pseudo-random — a fixed schedule computed once at module
 * load, never Math.random() at runtime, so the piece plays identically every time.
 * Gaze targeting overrides the idle schedule whenever the agents should be paying
 * attention to something: the orbiting chips, each absorption, the arriving panel, each
 * incoming message.
 */

// Pupil travel, in SVG user units (the avatars render at ~0.14 scale in the slots).
const PUPIL_X = 18;
const PUPIL_Y = 12;

function hash(seed: number, n: number): number {
  const x = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function buildSaccades(seed: number, from: number, to: number): Saccade[] {
  const out: Saccade[] = [];
  let t = from;
  for (let i = 0; t < to; i += 1) {
    t += 0.7 + hash(seed, i) * 0.9; // 700-1600ms dwell
    out.push({
      at: t,
      x: (hash(seed, i + 101) * 2 - 1) * PUPIL_X,
      y: (hash(seed, i + 211) * 2 - 1) * PUPIL_Y,
    });
  }
  return out;
}

function buildBlinks(seed: number, from: number, to: number, extra: number[]): number[] {
  const out = [...extra];
  let t = from;
  for (let i = 0; t < to; i += 1) {
    t += 2.4 + hash(seed, i + 37) * 2.4; // every 2.4-4.8s
    if (t < to) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

const EYE_SCHEDULE = {
  // first blink at 1.70 / 1.79 (90ms offset), settle blinks at 7.30 / 7.40 — never in unison
  writer: {
    saccades: buildSaccades(11, 1.7, DURATION),
    blinks: buildBlinks(11, 1.9, DURATION, [1.7, 7.3]),
  },
  builder: {
    saccades: buildSaccades(29, 1.7, DURATION),
    blinks: buildBlinks(29, 1.9, DURATION, [1.79, 7.4]),
  },
};

const BLINK_DUR = 0.14;

/** Shared orbit rotation at time t, in degrees. */
function orbitDelta(t: number): number {
  if (t <= ORBIT.start) return 0;
  return Math.min(ORBIT.rate * (t - ORBIT.start), ORBIT_TOTAL);
}

/** Unit direction toward a chip, in pupil units. */
function towardChip(chipIndex: number, t: number): Gaze {
  const chip = CHIPS[chipIndex];
  const rad = ((chip.angle + orbitDelta(t)) * Math.PI) / 180;
  return { x: Math.cos(rad) * PUPIL_X, y: Math.sin(rad) * PUPIL_Y };
}

/*
 * Two chips per agent for the whole chip act, picked on opposite sides of the ring: the
 * writer takes the upper-left then the upper-right, the builder the lower-right then the
 * lower-left. So the pair covers the ring between them and the two are never pointing the
 * same way. The hand-offs are 180ms apart so they don't move in unison.
 */
const CHIP_GAZE = {
  writer: { chips: [0, 4], switchAt: 2.6 }, // Models (upper-left) -> Connections (upper-right)
  builder: { chips: [3, 2], switchAt: 2.78 }, // Permissions (lower-right) -> Instructions (lower-left)
};

/*
 * The power-up smile: the pupils give way to happy arcs while the capabilities land, from
 * the first absorption hit to a beat after the last. Derived from the absorb beats, so
 * retiming the absorptions retimes the smile with them.
 */
export const SMILE = {
  from: absorbAt(0) + ABSORB.duration - 0.1, // 3.40
  to: absorbAt(ABSORB_ORDER.length - 1) + ABSORB.duration + 0.34, // 4.68
};

/**
 * Smile at time t: 1 = happy arcs, 0 = round pupils. A hard swap on both edges — a fade
 * puts both eye treatments on screen at once, which reads as a ghost rather than a change
 * of expression.
 */
function smileAt(t: number): number {
  return t >= SMILE.from && t < SMILE.to ? 1 : 0;
}

/**
 * Where an agent is deliberately looking at time t, or null to fall back to idle saccades.
 */
function gazeAt(agent: AgentKey, t: number): Gaze | null {
  /*
   * Act 3 — the chips. Tracking every chip as it popped and again as it was absorbed gave
   * each agent ten gaze hand-offs inside 2.5s, which read as frantic. Each agent now takes
   * two chips and smooth-tracks them through the orbit; once the absorptions start, the
   * smile takes over and the eyes stop moving entirely.
   */
  if (t >= POP.start && t < SMILE.from) {
    const g = CHIP_GAZE[agent];
    return towardChip(t < g.switchAt ? g.chips[0] : g.chips[1], t);
  }
  /*
   * Out of the smile and into the toss, the eyes open centred and hold. Dropping back to
   * idle saccades here spends the calm the smile just bought, on nothing.
   */
  if (t >= SMILE.from && t < 5.45) return { x: 0, y: 0 };
  // Act 4 — the panel builds itself underneath; each agent looks down at it until its own
  // launch, which is no longer the same frame for both.
  if (t >= 5.45 && t < TAIL[agent].open) return { x: 0, y: PUPIL_Y * 0.9 };

  // Each agent watches its own row as it flies into it — gaze follows the flight vector.
  const own = TAIL[agent];
  if (own && t >= own.open && t < own.open + EJECT[agent].flight) {
    const e = EJECT[agent];
    const len = Math.hypot(e.dx, e.dy);
    return { x: (e.dx / len) * PUPIL_X, y: (e.dy / len) * PUPIL_Y };
  }

  // Impact: Lassya's message lands below them, to the right of her avatar.
  if (t >= TAIL.lassya && t < TAIL.writer.say) return { x: PUPIL_X * 0.5, y: PUPIL_Y * 0.9 };

  // Landed: both sit in the avatar column, so a message is always off to the right — its own
  // (level) or the other agent's (above if the speaker is the writer, below if the builder).
  if (t >= TAIL.writer.say && t < TAIL.builder.say) {
    return agent === 'writer'
      ? { x: PUPIL_X * 0.85, y: -PUPIL_Y * 0.3 }
      : { x: PUPIL_X * 0.7, y: -PUPIL_Y * 0.8 };
  }
  if (t >= TAIL.builder.say && t < TAIL.settle) {
    return agent === 'builder'
      ? { x: PUPIL_X * 0.85, y: -PUPIL_Y * 0.3 }
      : { x: PUPIL_X * 0.6, y: PUPIL_Y * 0.8 };
  }
  if (t >= TAIL.settle) return { x: 0, y: 0 }; // recentre on the settle
  return null;
}

/**
 * Deterministic eye state for one agent at time t.
 * @returns pupil offset in SVG units, eyelid scaleY, and the smile (0 or 1)
 */
export function eyeState(agent: AgentKey, t: number): EyeState {
  const sched = EYE_SCHEDULE[agent];
  const smile = smileAt(t);

  // No blinking while the smile is up — the arcs have no lid to close.
  let blink = 1;
  if (smile === 0) {
    for (let i = 0; i < sched.blinks.length; i += 1) {
      const d = t - sched.blinks[i];
      if (d >= 0 && d <= BLINK_DUR) {
        const p = d / BLINK_DUR;
        blink = p < 0.5 ? 1 - (p / 0.5) * 0.92 : 0.08 + ((p - 0.5) / 0.5) * 0.92;
        break;
      }
    }
  }

  const gaze = gazeAt(agent, t);
  if (gaze) return { ...gaze, blink, smile };

  let target: Gaze = { x: 0, y: 0 };
  for (let i = 0; i < sched.saccades.length; i += 1) {
    if (sched.saccades[i].at > t) break;
    target = sched.saccades[i];
  }
  return { x: target.x, y: target.y, blink, smile };
}
