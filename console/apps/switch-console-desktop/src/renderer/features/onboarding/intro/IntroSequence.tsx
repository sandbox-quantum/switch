import { useAnimate, useMotionValue, useReducedMotion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { EjectedAgents } from './AgentAvatar';
import { CapabilityRing } from './CapabilityRing';
import { ChatPanel, PanelGlow } from './ChatPanel';
import { SwitchMark } from './SwitchMark';
import { DURATION, buildSequence } from './timeline';

interface IntroSequenceProps {
  onComplete?: () => void;
}

/*
 * <IntroSequence onComplete={} /> — the whole 10.2s piece, self-contained so it can drop
 * into the onboarding wizard later as a pre-wizard splash.
 *
 * One `useAnimate()` scope, one `animate([...])` call. Every beat in timeline.ts carries an
 * absolute `at:` offset, so the sequence array reads as the beat sheet and the playback head
 * is single.
 *
 * Every animated element carries an inline style matching the first keyframe of its first
 * beat, and every segment uses explicit [from, to] arrays — nothing is read back off the
 * DOM, so the piece is identical on every play.
 */
export function IntroSequence({ onComplete }: IntroSequenceProps) {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const clock = useMotionValue(0);
  const onCompleteRef = useRef(onComplete);
  const reduced = useReducedMotion();

  // kept in a ref so changing the callback never restarts the sequence
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    const controls = animate(buildSequence(clock));

    if (reduced) {
      // Reduced motion: same composition, no movement — jump the playback head to the end.
      controls.time = DURATION;
      controls.pause();
      clock.set(DURATION);
      onCompleteRef.current?.();
      return () => controls.stop();
    }

    let cancelled = false;
    void controls.then(() => {
      if (!cancelled) onCompleteRef.current?.();
    });
    return () => {
      cancelled = true;
      controls.stop();
    };
  }, [animate, clock, reduced]);

  return (
    <div ref={scope} className="absolute inset-0">
      <CapabilityRing />
      <SwitchMark clock={clock} />
      <PanelGlow />
      <ChatPanel clock={clock} />
      <EjectedAgents clock={clock} />
    </div>
  );
}
