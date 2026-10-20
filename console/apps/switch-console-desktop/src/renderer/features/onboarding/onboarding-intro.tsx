import { motion } from 'motion/react';
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTheme } from '@renderer/lib/hooks/useTheme';
import { Button } from '@renderer/lib/ui/button';
import { log } from '@renderer/utils/logger';
import aurora from './intro/assets/aurora.svg';
import './intro/fonts/intro-fonts.css';
import { introScale } from './intro/intro-scale';
import { IntroSequence } from './intro/IntroSequence';
import { STAGE, THEMES } from './intro/timeline';

/** How long the last frame holds before the intro gives way to Welcome. */
const HOLD_S = 0.5;
/**
 * The way out, at the end or on a skip: the chat rises and fades, the glow
 * behind it fades, and Welcome comes in after.
 */
const OUTRO = { duration: 0.42, ease: [0.4, 0, 0.2, 1] } as const;
/** How far the chat rises as it goes, in stage pixels. */
const OUTRO_RISE = 48;

/**
 * The intro that opens the first run, before Welcome: the Switch mark opens,
 * two agents take in what Switch does and step out into a conversation. An
 * install onboarded before it existed gets it once over the app instead.
 *
 * The real window is its frame. It plays once at full size, smaller only in a
 * smaller window, in the app's theme, then fades into what it stood in front
 * of. A click, Esc or Skip goes straight there; with reduced motion it shows
 * its last frame. If it fails to draw, it counts as done rather than standing
 * between the user and the app.
 */
export function OnboardingIntro({ onDone }: { onDone: () => void }) {
  return (
    <IntroBoundary onFailed={onDone}>
      <IntroPlayer onDone={onDone} />
    </IntroBoundary>
  );
}

class IntroBoundary extends Component<
  { onFailed: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.warn('The intro failed to draw; skipping it', {
      event: 'onboarding_intro_failed',
      error: { name: error.name, message: error.message, stack: error.stack },
      componentStack: info.componentStack,
    });
    this.props.onFailed();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function IntroPlayer({ onDone }: { onDone: () => void }) {
  const { effectiveTheme } = useTheme();
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setScale(introScale(element.getBoundingClientRect()));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const leave = useCallback(() => setLeaving(true), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [leave]);

  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current);
    },
    []
  );
  const finished = useCallback(() => {
    hold.current = setTimeout(leave, HOLD_S * 1000);
  }, [leave]);

  const theme = THEMES[effectiveTheme === 'emdark' ? 'dark' : 'light'] as CSSProperties;

  return (
    <div className="relative h-full w-full overflow-hidden bg-background" style={theme}>
      {/* The window can still be dragged by its top edge, as on every page. */}
      <div className="absolute inset-x-0 top-0 z-50 h-10 [-webkit-app-region:drag]" />
      <motion.div
        className="absolute top-3 right-3 z-50 [-webkit-app-region:no-drag]"
        initial={false}
        animate={{ opacity: leaving ? 0 : 1 }}
        transition={OUTRO}
      >
        <Button variant="ghost" size="sm" onClick={leave}>
          Skip
        </Button>
      </motion.div>
      <div
        ref={frame}
        className="absolute inset-0 flex cursor-default items-center justify-center"
        onClick={leave}
      >
        <div
          className="relative shrink-0"
          style={{ width: STAGE.w, height: STAGE.h, transform: `scale(${scale})` }}
          role="img"
          aria-label="Switch: the Switch mark opens, two agents appear inside it, take in five capabilities, and step out into a chat conversation."
        >
          {/*
            aurora.svg is the 1888x925 shape plus 300px of blur bleed on every
            side, so drawn at its natural size on the stage's centre it sits
            where the design has it, blur intact.
          */}
          <motion.div
            className="pointer-events-none absolute inset-0"
            initial={false}
            animate={{ opacity: leaving ? 0 : 1 }}
            transition={OUTRO}
          >
            <img
              src={aurora}
              alt=""
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                width: 2488,
                height: 1525,
                left: 'calc(50% + 9px)',
                top: 'calc(50% + 181.5px)',
                transform: 'translate(-50%, -50%) rotate(180deg)',
                opacity: 'var(--sw-aurora-opacity)',
                mixBlendMode: 'var(--sw-aurora-blend)' as CSSProperties['mixBlendMode'],
              }}
            />
          </motion.div>
          <motion.div
            className="absolute inset-0"
            initial={false}
            animate={leaving ? { opacity: 0, y: -OUTRO_RISE } : { opacity: 1, y: 0 }}
            transition={OUTRO}
            onAnimationComplete={() => {
              if (leaving) doneRef.current();
            }}
          >
            <IntroSequence onComplete={finished} />
          </motion.div>
        </div>
      </div>
    </div>
  );
}
