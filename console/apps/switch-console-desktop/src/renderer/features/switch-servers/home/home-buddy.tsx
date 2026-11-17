import { BuddyFace, useBuddyExpression } from '@switch-console/chat-ui/components/buddy-face';
import { motion, useReducedMotion } from 'motion/react';
import { type CSSProperties, useState } from 'react';
import { cn } from '@renderer/utils/utils';

const TILE = 78;
const FACE = TILE * 0.8;

/**
 * Home plays this every time it opens, so it is kept quiet: a short eased
 * rise, not the toss and squash Meet switch-buddy opens with.
 */
const SLIDE = { duration: 0.45, delay: 0.1, ease: [0.22, 1, 0.36, 1] } as const;
const RISING = { y: FACE * 0.45, opacity: 0 } as const;
const SETTLED = { y: 0, opacity: 1 } as const;

const TILE_STYLE: CSSProperties = {
  width: TILE,
  height: TILE,
  // Only the bottom edge clips, so the face rises out of the tile.
  clipPath: `inset(-100% -100% 0 -100% round 0 0 ${TILE * 0.22}px ${TILE * 0.22}px)`,
};

/**
 * switch-buddy on its tile beside Home's chat bar. It slides up into the tile
 * as the page opens, then blinks and smiles now and then, as it does when it
 * is first introduced. With reduced motion it is drawn still.
 */
export function HomeBuddy({ className }: { className?: string }) {
  const reduced = useReducedMotion() ?? false;
  const [arrived, setArrived] = useState(reduced);
  const expression = useBuddyExpression(arrived && !reduced);

  return (
    <span
      data-home-buddy
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[22%] bg-background-tertiary emdark:bg-background-3',
        className
      )}
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
