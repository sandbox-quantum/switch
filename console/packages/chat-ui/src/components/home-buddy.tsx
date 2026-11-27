import { motion, useReducedMotion } from 'motion/react';
import { type CSSProperties, useState } from 'react';
import { BuddyFace, useBuddyExpression } from './buddy-face';

const TILE = 78;
const FACE = TILE * 0.8;

const SLIDE = { duration: 0.45, delay: 0.1, ease: [0.22, 1, 0.36, 1] } as const;
const RISING = { y: FACE * 0.45, opacity: 0 } as const;
const SETTLED = { y: 0, opacity: 1 } as const;

const TILE_STYLE: CSSProperties = {
  width: TILE,
  height: TILE,
  clipPath: `inset(-100% -100% 0 -100% round 0 0 ${TILE * 0.22}px ${TILE * 0.22}px)`,
};

export function HomeBuddy({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const [arrived, setArrived] = useState(reduced);
  const expression = useBuddyExpression(arrived && !reduced);

  return (
    <span
      data-home-buddy
      className={`inline-flex shrink-0 items-center justify-center rounded-[22%] bg-background-tertiary emdark:bg-background-3 ${className ?? ''}`}
      style={TILE_STYLE}
    >
      <motion.span
        className="block"
        initial={reduced ? false : RISING}
        animate={SETTLED}
        transition={SLIDE}
        onAnimationComplete={() => setArrived(true)}
      >
        <BuddyFace size={FACE} expression={expression} />
      </motion.span>
    </span>
  );
}
