import {
  motion,
  type MotionValue,
  useMotionValue,
  useMotionValueEvent,
  useTransform,
} from 'motion/react';
import { AVATARS, EJECT, PALETTE, eyeState, type AgentKey } from './timeline';

/*
 * The two agents, inlined as real SVG.
 *
 * They are NOT <img> tags: each eye is its own <path> with `transform-box: fill-box`, so
 * pupil saccades (translate) and blinks (scaleY) are driven per-eye from the master clock.
 * The Figma export's #393939 backing rect and the two huge "Section 2" artboard paths are
 * stripped — only the body and the two eyes are real geometry.
 */

interface AgentShape {
  body: string;
  eyes: string[];
}

const SHAPES: Record<AgentKey, AgentShape> = {
  writer: {
    // shape-pill — visible bounds 60.8..451.2 x 129.8..382.2 inside the 512 box
    body:
      'M324.163 129.799L184.016 131.939C114.908 132.994 59.7401 189.872 60.7952 258.98C61.8503 ' +
      '328.088 118.729 383.256 187.837 382.201L327.983 380.061C397.091 379.006 452.259 322.128 ' +
      '451.204 253.02C450.149 183.912 393.27 128.744 324.163 129.799Z',
    eyes: [
      'M187.789 297.107C204.383 296.854 217.63 283.197 217.376 266.602C217.123 250.008 203.466 ' +
        '236.762 186.871 237.015C170.277 237.268 157.031 250.926 157.284 267.52C157.537 284.114 ' +
        '171.195 297.361 187.789 297.107Z',
      'M325.433 295.006C342.028 294.753 355.274 281.095 355.021 264.501C354.768 247.907 341.11 ' +
        '234.66 324.516 234.913C307.922 235.167 294.675 248.824 294.928 265.418C295.182 282.013 ' +
        '308.839 295.259 325.433 295.006Z',
    ],
  },
  builder: {
    // shape-diamond — visible bounds 66.5..445.5 both axes inside the 512 box
    body:
      'M189.52 109.065C224.545 68.9826 262.098 66.4538 302.181 101.479L402.935 189.52C443.017 ' +
      '224.544 445.546 262.098 410.521 302.181L322.481 402.935C287.456 443.017 249.902 445.546 ' +
      '209.819 410.521L109.065 322.48C68.9829 287.455 66.4541 249.902 101.479 209.819L189.52 109.065Z',
    eyes: [
      'M231.378 260.638C230.763 251.505 222.861 244.6 213.728 245.215C204.595 245.83 197.69 ' +
        '253.732 198.305 262.865L200.051 288.787C200.666 297.92 208.568 304.825 217.701 304.21C226.834 ' +
        '303.595 233.739 295.693 233.124 286.56L231.378 260.638Z',
      'M314.095 255.068C313.48 245.935 305.578 239.03 296.445 239.645C287.312 240.26 280.407 ' +
        '248.162 281.022 257.295L282.767 283.217C283.382 292.35 291.285 299.255 300.417 298.64C309.55 ' +
        '298.025 316.455 290.123 315.84 280.99L314.095 255.068Z',
    ],
  },
};

const EYE_STYLE = { transformBox: 'fill-box', transformOrigin: 'center' } as const;

/*
 * The power-up smile.
 *
 * The eye paths above are closed blobs, so their centres are recorded here and the smile is
 * generated from them — move the art and the smile follows. Each eye becomes one arc that
 * peaks upward, stroked with round caps so it reads as a happy closed eye rather than a
 * drawn line. `w` is the arc's half-width, which is the pupil's own half-width for the
 * writer's circles and a little wider than the builder's narrow ovals.
 */
interface SmileEye {
  cx: number;
  cy: number;
  w: number;
}

interface SmileGeom {
  stroke: number;
  eyes: SmileEye[];
}

const SMILE_GEOM: Record<AgentKey, SmileGeom> = {
  writer: {
    stroke: 17,
    eyes: [
      { cx: 187.3, cy: 267.2, w: 30 },
      { cx: 325.0, cy: 265.0, w: 30 },
    ],
  },
  builder: {
    stroke: 15,
    eyes: [
      { cx: 215.7, cy: 274.7, w: 24 },
      { cx: 298.4, cy: 269.1, w: 24 },
    ],
  },
};

// A quadratic peaks halfway to its control point, so the control sits twice as far above
// centre as the peak does: ends 7 below, peak 11 above.
function smileArc({ cx, cy, w }: SmileEye): string {
  const ends = cy + 7;
  return `M${cx - w} ${ends}Q${cx} ${2 * (cy - 11) - ends} ${cx + w} ${ends}`;
}

// capitalised local so eslint sees `motion` used (this config has no jsx-uses-vars for
// member expressions) and so JSX treats it as a component
const MotionPath = motion.path;

interface AgentAvatarProps {
  agent: AgentKey;
  clock: MotionValue<number>;
}

/** One agent. `clock` is the master playback head in seconds. */
export function AgentAvatar({ agent, clock }: AgentAvatarProps) {
  const shape = SHAPES[agent];
  const smileGeom = SMILE_GEOM[agent];
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const blink = useMotionValue(1);
  const smile = useMotionValue(0);
  // Exactly one eye treatment is ever on screen: the smile is 0 or 1, never in between.
  const pupilOpacity = useTransform(smile, (s) => 1 - s);

  // Pupils ease toward their target rather than snapping — a ~180ms settle at 60fps.
  useMotionValueEvent(clock, 'change', (t) => {
    const next = eyeState(agent, t);
    px.set(px.get() + (next.x - px.get()) * 0.22);
    py.set(py.get() + (next.y - py.get()) * 0.22);
    blink.set(next.blink);
    smile.set(next.smile);
  });

  return (
    <svg viewBox="0 0 512 512" className="h-full w-full overflow-visible" aria-hidden="true">
      <path d={shape.body} fill={AVATARS[agent].body} />
      {shape.eyes.map((d) => (
        <MotionPath
          key={d.slice(0, 24)}
          d={d}
          fill={PALETTE.eye}
          style={{ ...EYE_STYLE, x: px, y: py, scaleY: blink, opacity: pupilOpacity }}
        />
      ))}
      {smileGeom.eyes.map((eye) => (
        <MotionPath
          key={eye.cx}
          d={smileArc(eye)}
          fill="none"
          stroke={PALETTE.eye}
          strokeWidth={smileGeom.stroke}
          strokeLinecap="round"
          style={{ opacity: smile }}
        />
      ))}
    </svg>
  );
}

/**
 * The free-flying copies. Each takes over from its clipped in-slot agent at the moment that
 * agent's row opens in the chat (7.90s for the writer, 9.10s for the builder) — same pixels,
 * same frame — then arcs out of the logo and lands on its row tile, where the row's own
 * avatar takes over again so the agent rides the next push-up with its row. Keeping it one
 * continuous object is the whole point: nothing teleports.
 */
interface EjectedAgentsProps {
  clock: MotionValue<number>;
}

export function EjectedAgents({ clock }: EjectedAgentsProps) {
  return (
    <>
      {(['writer', 'builder'] as const).map((agent) => {
        const a = AVATARS[agent];
        const e = EJECT[agent];
        return (
          <div
            key={agent}
            className={`eject-${agent} pointer-events-none absolute z-30`}
            style={{
              left: e.fromLeft,
              top: e.fromTop,
              width: a.box,
              height: a.box,
              opacity: 0,
              transform: 'translate(0px, 0px) scale(1)',
            }}
          >
            <AgentAvatar agent={agent} clock={clock} />
          </div>
        );
      })}
    </>
  );
}
