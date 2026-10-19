import { motion, useAnimate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { BuddyFace, useBuddyExpression } from './buddy-face';
import { INTRO_BUBBLE_CLASS, IntroBubbles, buddyIntroLines } from './buddy-intro-lines';

/**
 * Meet switch-buddy's opening, as a short scene:
 *
 * 1. The avatar's tile rises into the middle of the screen.
 * 2. As it settles, switch-buddy is tossed up out of it and lands in place,
 *    squashing on impact; the tile gives under it.
 * 3. Just before it comes to rest, the title and the line under it slide in.
 * 4. The page makes room and the lines arrive as chat bubbles, one at a time,
 *    each springing in and typing itself out.
 *
 * From then on it blinks and smiles now and then. Every motion is a spring or
 * a gravity curve, and nothing overlaps more than the next beat needs.
 *
 * With reduced motion, or when `play` is false (coming back to the page), it
 * is drawn at rest.
 */

const TILE = 80;
const FACE = TILE * 0.8;

/** Seconds from the page opening. */
const BEAT = {
  tileIn: 0.12,
  toss: 0.4,
  title: 0.92,
  subtitle: 1.04,
  talk: 1.5,
  firstBubble: 1.82,
} as const;

/** A thrown object rises on a quadratic ease-out and falls on its mirror. */
const RISE: [number, number, number, number] = [0.333, 0.667, 0.667, 1];
const FALL: [number, number, number, number] = [0.333, 0, 0.667, 0.333];

/** How far it starts below its resting place (hidden in the tile) and how high above it the toss peaks. */
const START_BELOW = FACE * 1.1;
const PEAK_ABOVE = FACE * 0.42;
/** Under gravity, time to cover a height goes as its square root. */
const FLIGHT = 0.64;
const RISE_SHARE =
  Math.sqrt(START_BELOW + PEAK_ABOVE) /
  (Math.sqrt(START_BELOW + PEAK_ABOVE) + Math.sqrt(PEAK_ABOVE));

/** Characters typed per second. */
const TYPING_RATE = 80;
/** The pause after a bubble finishes before the next one appears. */
const BUBBLE_GAP = 0.2;
/** How long a bubble's spring runs before its text starts. */
const TYPING_LEAD = 0.09;

const ENTER_SPRING = { type: 'spring', stiffness: 170, damping: 21, mass: 1 } as const;
const TEXT_SPRING = { type: 'spring', stiffness: 260, damping: 26 } as const;
const BUBBLE_SPRING = { type: 'spring', stiffness: 480, damping: 19, mass: 0.9 } as const;
const LAYOUT_SPRING = { type: 'spring', stiffness: 150, damping: 24 } as const;

function seconds(value: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, value * 1000));
}

export function MeetBuddyIntro({
  firstName,
  play,
  onPlayed,
}: {
  firstName: string | null;
  play: boolean;
  onPlayed: () => void;
}) {
  const reduced = useReducedMotion() ?? false;
  const animated = play && !reduced;
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [landed, setLanded] = useState(!animated);
  const [talking, setTalking] = useState(!animated);
  const [bubble, setBubble] = useState(animated ? -1 : Number.POSITIVE_INFINITY);
  const expression = useBuddyExpression(landed && !reduced);
  const lines = buddyIntroLines(firstName);
  const playedRef = useRef(onPlayed);
  playedRef.current = onPlayed;

  useEffect(() => {
    if (!animated) return;
    let live = true;
    void (async () => {
      void animate(
        '[data-intro="tile"]',
        { opacity: [0, 1], y: [30, 0] },
        {
          opacity: { duration: 0.32, ease: 'easeOut', delay: BEAT.tileIn },
          y: { ...ENTER_SPRING, delay: BEAT.tileIn },
        }
      );
      await seconds(BEAT.toss);
      if (!live) return;
      void animate(
        '[data-intro="face"]',
        { y: [START_BELOW, -PEAK_ABOVE, 0], rotate: [-14, 4, 0] },
        {
          duration: FLIGHT,
          y: { duration: FLIGHT, times: [0, RISE_SHARE, 1], ease: [RISE, FALL] },
          rotate: { duration: FLIGHT, times: [0, RISE_SHARE, 1], ease: ['easeOut', 'easeInOut'] },
        }
      );
      // The beats run on the clock, not on each animation finishing.
      await seconds(FLIGHT);
      if (!live) return;
      // The landing: the face squashes and recovers, the tile gives a little under it.
      void animate(
        '[data-intro="face"]',
        { scaleY: 1, scaleX: 1 },
        {
          scaleY: { type: 'spring', stiffness: 520, damping: 13, velocity: -4.2 },
          scaleX: { type: 'spring', stiffness: 520, damping: 13, velocity: 3.2 },
        }
      );
      void animate(
        '[data-intro="tile"]',
        { y: 0 },
        { type: 'spring', stiffness: 380, damping: 15, velocity: 70 }
      );
      setLanded(true);
      await seconds(BEAT.talk - BEAT.toss - FLIGHT);
      if (!live) return;
      setTalking(true);
      await seconds(BEAT.firstBubble - BEAT.talk);
      if (live) setBubble(0);
    })();
    return () => {
      live = false;
      // Leaving part-way counts as having seen it: coming back draws it at rest.
      playedRef.current();
    };
  }, [animated, animate]);

  const nextBubble = (index: number) => {
    void seconds(BUBBLE_GAP).then(() => {
      setBubble((current) => (current === index ? index + 1 : current));
      if (index === lines.length - 1) playedRef.current();
    });
  };

  return (
    <div ref={scope} className="contents">
      <motion.div
        layout={animated ? 'position' : false}
        transition={LAYOUT_SPRING}
        className="flex flex-col items-center gap-2 text-center"
      >
        <span
          data-intro="tile"
          className="relative inline-flex shrink-0 items-center justify-center rounded-[22%] bg-[linear-gradient(180deg,rgb(231_246_249/0.2),rgb(136_145_147/0.2))] emdark:bg-[linear-gradient(180deg,rgb(231_246_249/0.12),rgb(136_145_147/0.07))]"
          style={{
            width: TILE,
            height: TILE,
            opacity: animated ? 0 : 1,
            // Only the bottom edge clips: switch-buddy is hidden below it
            // before the toss, and free above it during.
            clipPath: `inset(-200% -100% 0 -100% round 0 0 ${TILE * 0.22}px ${TILE * 0.22}px)`,
          }}
        >
          <span
            data-intro="face"
            className="block"
            style={{
              transformOrigin: '50% 85%',
              transform: animated ? `translateY(${START_BELOW}px)` : undefined,
            }}
          >
            <BuddyFace size={FACE} expression={expression} />
          </span>
        </span>
        <motion.h1
          className="mt-2 text-2xl font-semibold"
          initial={animated ? { opacity: 0, y: 12 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            ...TEXT_SPRING,
            delay: BEAT.title,
            opacity: { duration: 0.28, delay: BEAT.title },
          }}
        >
          Meet switch-buddy
        </motion.h1>
        <motion.p
          className="text-sm text-foreground-muted"
          initial={animated ? { opacity: 0, y: 10 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            ...TEXT_SPRING,
            delay: BEAT.subtitle,
            opacity: { duration: 0.28, delay: BEAT.subtitle },
          }}
        >
          Your first AI assistant in Switch
        </motion.p>
      </motion.div>
      {talking && (
        <IntroBubbles>
          {lines.map((line, index) => (
            <TypedBubble
              key={line}
              text={line}
              state={index < bubble ? 'done' : index === bubble ? 'typing' : 'waiting'}
              animated={animated}
              onTyped={() => nextBubble(index)}
            />
          ))}
        </IntroBubbles>
      )}
    </div>
  );
}

/**
 * One line as a chat bubble. It holds its full size from the start, the text
 * still to come drawn transparent, so nothing around it moves as it types.
 * Screen readers get the whole line at once.
 */
function TypedBubble({
  text,
  state,
  animated,
  onTyped,
}: {
  text: string;
  state: 'waiting' | 'typing' | 'done';
  animated: boolean;
  onTyped: () => void;
}) {
  const [typed, setTyped] = useState(animated ? 0 : text.length);
  const typedRef = useRef(onTyped);
  typedRef.current = onTyped;

  useEffect(() => {
    if (state !== 'typing') return;
    // A timer rather than animation frames: a window the browser is not
    // painting stops those, and the next bubble waits on this one finishing.
    const start = performance.now() + TYPING_LEAD * 1000;
    const total = (text.length / TYPING_RATE) * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const elapsed = performance.now() - start;
      if (elapsed >= 0) {
        // Eased so the first characters come a touch quicker than the last.
        const progress = Math.min(1, elapsed / total);
        const eased = 1 - (1 - progress) ** 1.6;
        setTyped(Math.round(eased * text.length));
        if (progress >= 1) {
          typedRef.current();
          return;
        }
      }
      timer = setTimeout(step, 16);
    };
    timer = setTimeout(step, 16);
    return () => clearTimeout(timer);
  }, [state, text]);

  const shown = state === 'done' ? text.length : state === 'waiting' ? 0 : typed;
  return (
    <motion.p
      className={INTRO_BUBBLE_CLASS}
      style={{ transformOrigin: '0% 100%' }}
      initial={animated ? { opacity: 0, scale: 0.6, y: 10 } : false}
      animate={
        state === 'waiting' ? { opacity: 0, scale: 0.6, y: 10 } : { opacity: 1, scale: 1, y: 0 }
      }
      transition={{ ...BUBBLE_SPRING, opacity: { duration: 0.14 } }}
    >
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {text.slice(0, shown)}
        <span className="text-transparent">{text.slice(shown)}</span>
      </span>
    </motion.p>
  );
}
