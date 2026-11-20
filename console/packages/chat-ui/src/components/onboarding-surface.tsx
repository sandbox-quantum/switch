import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';
import { Button } from '../primitives/button';

/**
 * The way out of a wizard that fills the window.
 *
 * A dialog has its own — Escape, the backdrop, a Cancel button — and something
 * behind it to return to. A full-window wizard has neither, so a flow that can
 * be left part-way has to say so in words on every page rather than relying on
 * the user pressing Back until the window changes shape under them.
 */
export type WizardExit = { label: string; onExit: () => void };

/**
 * A soft wash of colour behind the first-run pages, low enough in alpha to
 * read on the light and the dark theme alike.
 */
export const ONBOARDING_BACKDROP =
  'radial-gradient(60% 45% at 50% 48%, rgba(120, 180, 185, 0.12), transparent 70%), ' +
  'radial-gradient(70% 55% at 10% 100%, rgba(255, 160, 110, 0.22), transparent 70%), ' +
  'radial-gradient(60% 50% at 90% 100%, rgba(255, 190, 150, 0.14), transparent 70%)';

/**
 * The window-filling surface every first-run page is drawn on: the backdrop,
 * the way out at the top, the page centred, and its buttons centred at the
 * foot, where the eye ends up after reading the page. The pages are not
 * numbered steps there, so the dialog's step pager is left out: Back is a
 * button on each page that has one.
 */
/** How a first-run page's content arrives: a short rise and fade, the same spring as Meet switch-buddy's title. */
const PAGE_ENTER = { type: 'spring', stiffness: 260, damping: 26 } as const;

export function OnboardingSurface({
  exit,
  footer,
  enter = true,
  children,
}: {
  exit: WizardExit | null;
  footer: ReactNode | null;
  /** Whether the content rises and fades in as the page opens; off for a page that stages its own entrance. */
  enter?: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotion() ?? false;
  const animated = enter && !reduced;
  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-background text-foreground [-webkit-app-region:drag]"
      style={{ backgroundImage: ONBOARDING_BACKDROP }}
    >
      {/* The title bar of a frameless window: the page column below opts its
          whole height out of the drag region, so this row is what the window
          is moved by, with or without a way out in it. */}
      <div
        data-slot="onboarding-titlebar"
        className="flex h-11 shrink-0 items-center justify-end px-3 [-webkit-app-region:drag]"
      >
        {exit && (
          <Button
            variant="ghost"
            size="sm"
            className="[-webkit-app-region:no-drag]"
            onClick={exit.onExit}
          >
            {exit.label}
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {/* The entrance starts the page lower than where it lands, and a page
            that exactly fills the scroller would overflow it by that much and
            flash a scrollbar while it rises. Clipped here, so the scroller
            measures the page where it will rest; it still grows with a page
            taller than the window, which scrolls as before. */}
        <div className="flex flex-[1_0_auto] flex-col overflow-y-clip">
          <motion.div
            initial={animated ? { opacity: 0, y: 14 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...PAGE_ENTER, opacity: { duration: 0.24, ease: 'easeOut' } }}
            className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center gap-6 px-8 py-10 [-webkit-app-region:no-drag]"
          >
            {children}
          </motion.div>
        </div>
      </div>
      {footer && (
        <motion.div
          initial={animated ? { opacity: 0, y: 10 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{
            ...PAGE_ENTER,
            delay: 0.06,
            opacity: { duration: 0.24, ease: 'easeOut', delay: 0.06 },
          }}
          className="flex justify-center gap-2 px-8 pt-2 pb-6 [-webkit-app-region:no-drag]"
        >
          {footer}
        </motion.div>
      )}
    </div>
  );
}
