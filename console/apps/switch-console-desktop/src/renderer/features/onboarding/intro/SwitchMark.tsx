import { type MotionValue } from 'motion/react';
import { AgentAvatar } from './AgentAvatar';
import { AVATARS, MARK, MARK_CLIP, PALETTE, ABSORB_ORDER, MARK_T, type AgentKey } from './timeline';

/*
 * The Switch mark, inlined as real SVG.
 *
 * The hollow-out is a real *thinning*, not an outline of the original: the black mass loses
 * thickness progressively until it is a 1px line drawing — outer chamfered square plus one
 * horizontal divider, no pips.
 *
 * That is driven by a single thickness `T`, via a clip-path rig:
 *   - the outer ring is the outer path stroked at `2T` and clipped to itself, so exactly `T`
 *     of it shows inward
 *   - the divider is a line across the middle at width `T`
 * At T = 13.3958 (the logo's real ring thickness) the rig reconstructs the logo exactly; at
 * T = 1 it is the line drawing. No `vector-effect` — T is in user units, which is the point.
 *
 * One caveat: the real logo's inner bar corners are rounded at r≈7.3, but a constant-offset
 * stroke gives r≈1.2. That is only visible while the stroke is thick, so the exact filled
 * path carries the static opening and crossfades out over the first 120ms of the morph while
 * the rig thins underneath. Exact at both ends; the discrepancy is masked in between.
 *
 * The Figma export's #393939 backing rect and the two "Section 2" artboard paths are stripped.
 */

const PIPS = [
  'M29.8503 79.9215C32.8769 79.9215 35.3304 82.375 35.3304 85.4016V93.9261C35.3304 96.9527 32.8769 99.4062 29.8503 99.4062C26.8237 99.4062 24.3702 96.9527 24.3702 93.9261V85.4016C24.3702 82.375 26.8237 79.9215 29.8503 79.9215Z',
  'M51.7706 79.9215C54.7972 79.9215 57.2507 82.375 57.2507 85.4016V93.9261C57.2507 96.9527 54.7972 99.4062 51.7706 99.4062C48.7441 99.4062 46.2905 96.9527 46.2905 93.9261V85.4016C46.2905 82.375 48.7441 79.9215 51.7706 79.9215Z',
  'M72.2365 24.5783C75.2631 24.5783 77.7166 27.0318 77.7166 30.0584V38.583C77.7166 41.6096 75.2631 44.0631 72.2365 44.0631C69.2099 44.0631 66.7564 41.6096 66.7564 38.583V30.0584C66.7564 27.0318 69.2099 24.5783 72.2365 24.5783Z',
  'M94.1568 24.5783C97.1834 24.5783 99.6369 27.0318 99.6369 30.0584V38.583C99.6369 41.6096 97.1834 44.0631 94.1568 44.0631C91.1303 44.0631 88.6768 41.6096 88.6768 38.583V30.0584C88.6768 27.0318 91.1303 24.5783 94.1568 24.5783Z',
];

// Outer chamfered square only — the first subpath of the full mark, without the two bar holes.
const OUTER =
  'M109.386 0C117.457 0 124 6.54271 124 14.6136V90.3917C124 94.2674 122.46 97.9845 119.72 ' +
  '100.725L100.725 119.72C97.9845 122.46 94.2674 124 90.3917 124H14.6136C6.54272 124 0 117.457 ' +
  '0 109.386V33.6083C0 29.7326 1.5396 26.0155 4.28013 23.2749L23.2749 4.28013C26.0155 1.5396 ' +
  '29.7326 0 33.6083 0H109.386Z';

// The exact filled logo: outer square minus the two bar holes (evenodd).
const BODY =
  OUTER +
  'M19.4847 68.6985C16.1219 68.6985 13.3958 71.4246 13.3958 ' +
  '74.7875V103.297C13.3958 107.333 16.6671 110.604 20.7025 110.604H84.8426C88.7183 110.604 ' +
  '92.4355 109.065 95.176 106.324L106.324 95.176C109.065 92.4355 110.604 88.7183 110.604 ' +
  '84.8426V74.7875C110.604 71.4246 107.878 68.6985 104.515 68.6985H19.4847ZM39.1574 ' +
  '13.3958C35.2817 13.3958 31.5645 14.9354 28.824 17.6759L17.6759 28.824C14.9354 31.5645 ' +
  '13.3958 35.2817 13.3958 39.1574V49.2137C13.3958 52.5766 16.1219 55.3027 19.4847 ' +
  '55.3027H104.515C107.878 55.3027 110.604 52.5766 110.604 49.2137V20.7025C110.604 16.6671 ' +
  '107.333 13.3958 103.297 13.3958H39.1574Z';

/*
 * `strokeWidth` is the one property the sequence drives in JS rather than through WAAPI
 * (only opacity / transform / filter / clipPath get accelerated). motion/react writes it to
 * the element's `stroke-width` ATTRIBUTE, and an inline style outranks a presentation
 * attribute, so the starting thickness must be an attribute too: written as inline style,
 * it held the logo solid while the animation thinned an attribute nobody could see. If
 * React owned it (as a prop), a re-render — e.g. a parent's state change on completion —
 * would stomp the animated value back to full thickness.
 *
 * So the initial thickness is set once imperatively and the animation is its sole owner.
 * These callbacks are module-level on purpose: a ref callback with a changing identity is
 * re-invoked (null, then the node) on every render, which would reintroduce the same stomp.
 */
const initRingStroke = (el: SVGPathElement | null): void => {
  if (el) el.setAttribute('stroke-width', String(MARK_T.from * 2));
};
const initDividerStroke = (el: SVGLineElement | null): void => {
  if (el) el.setAttribute('stroke-width', String(MARK_T.from));
};

const CLIP_OUTER = 'switch-mark-outer';
const CLIP_UPPER = 'switch-mark-slot-upper';
const CLIP_LOWER = 'switch-mark-slot-lower';

/*
 * Power-up bloom. One per absorption hit, per agent, in that agent's own colour — rendered in
 * the mark body rather than inside the slot clip so it isn't cut off by the slot, but BEFORE
 * the slots so it blooms behind the agents and lights them from behind rather than washing
 * over their faces.
 *
 * Its opacity track starts at 0 deliberately: in a motion sequence a track holds its
 * FIRST KEYFRAME from t=0, not the element's inline style, so a non-zero opening keyframe
 * would park a visible blob on screen before the piece has even begun.
 */
interface GlowsProps {
  agent: AgentKey;
}

function Glows({ agent }: GlowsProps) {
  const a = AVATARS[agent];
  const size = a.box * 2;
  return ABSORB_ORDER.map((_, k) => (
    <div
      key={k}
      className={`glow-${agent}-${k} pointer-events-none absolute rounded-full`}
      style={{
        left: a.cx - size / 2,
        top: a.cy - size / 2,
        width: size,
        height: size,
        background: a.glow,
        opacity: 0,
        transform: 'scale(0.8)',
      }}
    />
  ));
}

/*
 * The crop shapes: the interior of the finished LINE DRAWING, not of the original thick
 * mark. An SVG clipPath UNIONs its children, so the silhouette and the half-plane are
 * intersected by clipping one clipPath with the other.
 *
 * `clipPathUnits="userSpaceOnUse"` makes the coordinates the referencing element's own
 * pixels, and the mark renders 1:1, so mark units map straight through.
 */
function MarkClipDefs() {
  return (
    <svg className="absolute h-0 w-0" aria-hidden="true">
      <defs>
        <clipPath id={CLIP_OUTER} clipPathUnits="userSpaceOnUse">
          <path d={OUTER} />
        </clipPath>
        <clipPath id={CLIP_UPPER} clipPathUnits="userSpaceOnUse" clipPath={`url(#${CLIP_OUTER})`}>
          <rect x="0" y="0" width={MARK.size} height={MARK_CLIP.upper} />
        </clipPath>
        <clipPath id={CLIP_LOWER} clipPathUnits="userSpaceOnUse" clipPath={`url(#${CLIP_OUTER})`}>
          <rect x="0" y={MARK_CLIP.lower} width={MARK.size} height={MARK.size - MARK_CLIP.lower} />
        </clipPath>
      </defs>
    </svg>
  );
}

/* One agent, cut by the line drawing rather than by a rectangle. A rect wrapper cannot
 * express this crop — it has to follow the chamfered corners of the silhouette. */
interface SlotProps {
  agent: AgentKey;
  clock: MotionValue<number>;
}

function Slot({ agent, clock }: SlotProps) {
  const a = AVATARS[agent];
  const clip = agent === 'writer' ? CLIP_UPPER : CLIP_LOWER;
  return (
    <div className="absolute inset-0" style={{ clipPath: `url(#${clip})` }}>
      <div
        className={`agent-${agent} absolute`}
        style={{
          left: a.left,
          top: a.top,
          width: a.box,
          height: a.box,
          opacity: 0,
          transform: 'translateY(18px) scale(0.4)',
        }}
      >
        <AgentAvatar agent={agent} clock={clock} />
      </div>
    </div>
  );
}

interface SwitchMarkProps {
  clock: MotionValue<number>;
}

export function SwitchMark({ clock }: SwitchMarkProps) {
  return (
    <div
      className="mark-layer pointer-events-none absolute z-10"
      style={{
        left: MARK.left,
        top: MARK.top,
        width: MARK.size,
        height: MARK.size,
        transform: 'translateY(0px)',
      }}
    >
      <div className="mark-body absolute inset-0" style={{ opacity: 0, transform: 'scale(0.82)' }}>
        <MarkClipDefs />

        {/*
          The agents render UNDER the mark's artwork, so the line art always draws over their
          cut edges: a sub-pixel crop error becomes invisible instead of becoming a gap, and
          the ring correctly covers them during the window where they pop while the morph is
          still finishing.
        */}
        <Glows agent="writer" />
        <Glows agent="builder" />

        <Slot agent="writer" clock={clock} />
        <Slot agent="builder" clock={clock} />

        {/*
          fill and stroke live on the <svg> and the children inherit them, because a CSS
          variable does NOT resolve in an SVG presentation attribute — only in a CSS
          declaration. The one child that must not inherit the fill says so itself
          (`fill="none"` on the ring).
        */}
        <svg
          viewBox="0 0 124 124"
          className="absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
          style={{ fill: PALETTE.ink, stroke: PALETTE.ink }}
        >
          {/* the thinning rig: ring + divider, driven by one thickness */}
          {/*
            Opaque from the start, and UNDERNEATH `.mark-solid` — so the hand-over fades only
            the top layer and the composite stays 100% black, instead of dipping to ~75%
            mid-crossfade. Nothing animates this opacity: if you set it to 0 here, the rig is
            never turned on and the whole line-art logo is invisible for the entire piece.
          */}
          <g className="mark-rig" clipPath={`url(#${CLIP_OUTER})`} style={{ opacity: 1 }}>
            <path
              ref={initRingStroke}
              className="mark-ring"
              d={OUTER}
              fill="none"
              strokeLinejoin="round"
            />
            <line
              ref={initDividerStroke}
              className="mark-divider"
              x1="0"
              y1={MARK_T.dividerY}
              x2="124"
              y2={MARK_T.dividerY}
            />
          </g>

          {/*
            the exact filled logo, on top, for the static opening. Its starting opacity is an
            attribute, not inline style: motion/react fades an SVG element's opacity
            ATTRIBUTE, which an inline style would outrank, holding the solid logo on top.
          */}
          <path className="mark-solid" d={BODY} fillRule="evenodd" clipRule="evenodd" opacity={1} />

          {PIPS.map((d) => (
            <path
              key={d.slice(0, 18)}
              className="mark-pip"
              d={d}
              style={{ opacity: 1, transform: 'scale(1)' }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
