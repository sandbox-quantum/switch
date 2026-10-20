import { MessagesSquare, ShieldCheck, Users } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { UsageDataNotice } from '@renderer/features/telemetry/usage-data-line';
import { SwitchConsoleAppIcon } from '@renderer/lib/switch-console-app-icon';
import { Button } from '@renderer/lib/ui/button';
import { OnboardingSurface, useWizardExit } from '@renderer/lib/ui/wizard-frame';

/**
 * The first page of a fresh install: what Switch is, in three sentences, and
 * one button. Where it runs is the next page's question; this one only has to
 * say why anyone would want it to run at all.
 */
/**
 * How Welcome's pieces arrive: each rises and fades in, a beat after the one
 * before and overlapping it, on a long ease-out, so the page assembles quickly
 * but settles softly. In reading order: icon, heading, the three points one
 * by one, the usage note, then the button.
 */
const ENTER_EASE = [0.22, 1, 0.36, 1] as const;
const ENTER_DURATION = 0.6;
const ENTER_STAGGER = 0.07;

function Enter({
  order,
  as = 'div',
  className,
  children,
}: {
  order: number;
  as?: 'div' | 'li';
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;
  const Element = as === 'li' ? motion.li : motion.div;
  return (
    <Element
      className={className}
      initial={reduced ? false : { opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ENTER_DURATION, ease: ENTER_EASE, delay: order * ENTER_STAGGER }}
    >
      {children}
    </Element>
  );
}

export function WelcomePage({
  onContinue,
  onLeave,
}: {
  onContinue: () => void;
  /** Back to the app, when the pages were opened again rather than on a fresh install. */
  onLeave: (() => void) | null;
}) {
  const exit = useWizardExit();
  return (
    <OnboardingSurface
      exit={onLeave ? { label: 'Back to the app', onExit: onLeave } : exit}
      // Its pieces stage their own entrance, one after another.
      enter={false}
      footer={
        <Enter order={7}>
          <Button onClick={onContinue}>Get started</Button>
        </Enter>
      }
    >
      <div className="flex flex-col items-center gap-10">
        <Enter order={0}>
          <SwitchConsoleAppIcon size={96} className="rounded-3xl" />
        </Enter>
        <Enter order={1}>
          <h1 className="text-center text-3xl font-semibold">
            Your teams, your agents, all in the same room
          </h1>
        </Enter>
        <ul className="grid w-full gap-8 sm:grid-cols-3">
          <Point order={2} icon={<MessagesSquare className="size-5" />} title="In your chat app">
            Bring your agents from any provider to your messaging apps and start working together.
          </Point>
          <Point order={3} icon={<Users className="size-5" />} title="Shared knowledge">
            Chat history, instructions and documents available to every agent and person on the
            team.
          </Point>
          <Point order={4} icon={<ShieldCheck className="size-5" />} title="Security first">
            Built-in, customisable guardrails keep your data safe and your agents well-behaved.
          </Point>
        </ul>
        <Enter order={6}>
          <UsageDataNotice />
        </Enter>
      </div>
    </OnboardingSurface>
  );
}

function Point({
  order,
  icon,
  title,
  children,
}: {
  order: number;
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Enter as="li" order={order} className="flex list-none flex-col items-center gap-2 text-center">
      <span className="text-foreground-muted">{icon}</span>
      <span className="text-sm font-medium text-foreground">{title}</span>
      <p className="text-sm text-foreground-muted">{children}</p>
    </Enter>
  );
}
