import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

/**
 * switch-buddy's face drawn as a vector, the same picture as its avatar
 * image, so it can blink and smile. Drawn in the image's own 256×256 frame:
 * the face is a rounded square turned a few degrees, the eyes sit inside it.
 */
const BODY = '#8FB1F7';
const INK = '#16181D';
const TILT = 5.7;
const EYES = [
  { x: 96.6, y: 125.1, glintX: 100.6, glintY: 120.2 },
  { x: 158.1, y: 128, glintX: 162.2, glintY: 123.1 },
];
const EYE_RADIUS = 14.5;

type Expression = { blink: boolean; smile: boolean };

const BLINK_CLOSE = { duration: 0.07, ease: [0.4, 0, 1, 1] } as const;
const BLINK_OPEN = { duration: 0.12, ease: [0, 0, 0.2, 1] } as const;
const SMILE_SPRING = { type: 'spring', stiffness: 260, damping: 18 } as const;

export function BuddyFace({ size, expression }: { size: number; expression: Expression }) {
  // A smile is the eyes alone: each round eye gives way to a curved, happy one.
  const smiling = expression.smile && !expression.blink;
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden className="block">
      <g transform={`rotate(${TILT} 128 128)`}>
        <rect x={48} y={48} width={160} height={160} rx={38} fill={BODY} />
        {EYES.map((eye) => (
          <g key={eye.x}>
            <motion.g
              initial={false}
              animate={{
                scaleY: expression.blink ? 0.08 : smiling ? 0.3 : 1,
                opacity: smiling ? 0 : 1,
              }}
              transition={
                expression.blink
                  ? BLINK_CLOSE
                  : smiling
                    ? { ...SMILE_SPRING, opacity: { duration: 0.1 } }
                    : { ...BLINK_OPEN, opacity: { duration: 0.12, delay: 0.04 } }
              }
            >
              <circle cx={eye.x} cy={eye.y} r={EYE_RADIUS} fill={INK} />
              <circle cx={eye.glintX} cy={eye.glintY} r={4} fill="#fff" />
            </motion.g>
            <motion.path
              d={`M${eye.x - 12} ${eye.y + 4} Q${eye.x} ${eye.y - 14} ${eye.x + 12} ${eye.y + 4}`}
              fill="none"
              stroke={INK}
              strokeWidth={7}
              strokeLinecap="round"
              initial={false}
              animate={{
                pathLength: smiling ? 1 : 0,
                opacity: smiling ? 1 : 0,
                y: smiling ? 0 : 4,
              }}
              transition={{
                pathLength: SMILE_SPRING,
                y: SMILE_SPRING,
                opacity: { duration: smiling ? 0.08 : 0.14 },
              }}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * A face that blinks every few seconds, now and then twice, and smiles once
 * in a while, never both at once. Still while `alive` is false.
 */
export function useBuddyExpression(alive: boolean): Expression {
  const [expression, setExpression] = useState<Expression>({ blink: false, smile: false });

  useEffect(() => {
    if (!alive) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let stopped = false;
    const later = (seconds: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopped) run();
      }, seconds * 1000);
      timers.add(timer);
    };
    let smiling = false;

    const blinkOnce = (then: () => void) => {
      setExpression((current) => ({ ...current, blink: true }));
      later(0.11, () => {
        setExpression((current) => ({ ...current, blink: false }));
        then();
      });
    };
    const scheduleBlink = (seconds: number) =>
      later(seconds, () => {
        if (smiling) return scheduleBlink(between(0.8, 1.6));
        blinkOnce(() => {
          if (Math.random() < 0.18)
            later(0.16, () => blinkOnce(() => scheduleBlink(between(2.6, 5.4))));
          else scheduleBlink(between(2.6, 5.4));
        });
      });
    const scheduleSmile = (seconds: number) =>
      later(seconds, () => {
        smiling = true;
        setExpression({ blink: false, smile: true });
        later(between(1.3, 2), () => {
          smiling = false;
          setExpression({ blink: false, smile: false });
          scheduleSmile(between(7, 12));
        });
      });

    scheduleBlink(between(0.9, 1.6));
    scheduleSmile(between(3.2, 4.4));
    return () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      setExpression({ blink: false, smile: false });
    };
  }, [alive]);

  return expression;
}
