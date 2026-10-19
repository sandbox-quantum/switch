import { motion, useReducedMotion } from 'motion/react';
import { createContext, useContext, type ReactNode } from 'react';
import { Button } from './button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { StepPager } from './step-pager';

/**
 * Where a wizard page is being drawn: inside a dialog, or filling the window.
 *
 * The same pages serve both. Setting up a server is a dialog once you already
 * have one and the whole window on a fresh install, where there is no app
 * behind the dialog for it to sit on top of — but it is the same three
 * questions either way, and a second copy of them would be a second place for
 * the Docker check, the log tail and the sign-in form to drift.
 */
export type WizardChrome = 'dialog' | 'page';

const WizardChromeContext = createContext<WizardChrome>('dialog');

/**
 * The way out of a wizard that fills the window.
 *
 * A dialog has its own — Escape, the backdrop, a Cancel button — and something
 * behind it to return to. A full-window wizard has neither, so a flow that can
 * be left part-way has to say so in words on every page rather than relying on
 * the user pressing Back until the window changes shape under them.
 */
export type WizardExit = { label: string; onExit: () => void };

const WizardExitContext = createContext<WizardExit | null>(null);

export function WizardChromeProvider({
  chrome,
  exit,
  children,
}: {
  chrome: WizardChrome;
  /** Null until there is something to leave behind — a flow that has registered
   * nothing yet is left by finishing it or by stepping back off its first page. */
  exit: WizardExit | null;
  children: ReactNode;
}) {
  return (
    <WizardChromeContext.Provider value={chrome}>
      <WizardExitContext.Provider value={exit}>{children}</WizardExitContext.Provider>
    </WizardChromeContext.Provider>
  );
}

/** The pager under a page, or null where the page is not part of a sequence. */
export type WizardPager = {
  pageName: string;
  onBack: (() => void) | null;
  onNext: (() => void) | null;
};

/**
 * One page of a wizard: its question, its body, what it offers at the foot.
 *
 * The page supplies no chrome of its own. A dialog's title bar and a full
 * window's centred heading are the same title, and which one gets rendered is
 * the frame's business rather than the page's.
 */
export function WizardFrame({
  title,
  subtitle,
  footer,
  pager,
  children,
}: {
  title: string;
  /** The line under the title, or null where the title says enough. */
  subtitle: string | null;
  /** Buttons for the foot of the page, in reading order, or null for a page
   * whose only way on is the choice made in its body. */
  footer: ReactNode | null;
  pager: WizardPager | null;
  children: ReactNode;
}) {
  const chrome = useContext(WizardChromeContext);
  const exit = useContext(WizardExitContext);

  if (chrome === 'dialog') {
    return (
      <>
        <DialogHeader showCloseButton={false}>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="pt-0">
          {subtitle && <p className="pb-2 text-sm text-foreground-muted">{subtitle}</p>}
          {children}
        </DialogContentArea>
        {footer && <DialogFooter>{footer}</DialogFooter>}
        {pager && <StepPager {...pager} />}
      </>
    );
  }

  return (
    <OnboardingSurface exit={exit} footer={footer}>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-foreground-muted">{subtitle}</p>}
      </div>
      {children}
    </OnboardingSurface>
  );
}

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
      className="relative flex h-full flex-col bg-background text-foreground [-webkit-app-region:drag]"
      style={{ backgroundImage: ONBOARDING_BACKDROP }}
    >
      {exit && (
        <div className="flex justify-end px-3 pt-3 [-webkit-app-region:no-drag]">
          <Button variant="ghost" size="sm" onClick={exit.onExit}>
            {exit.label}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <motion.div
          initial={animated ? { opacity: 0, y: 14 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...PAGE_ENTER, opacity: { duration: 0.24, ease: 'easeOut' } }}
          className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center gap-6 px-8 py-10 [-webkit-app-region:no-drag]"
        >
          {children}
        </motion.div>
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

/** The way out the surrounding flow offers, for a page that draws its own surface. */
export function useWizardExit(): WizardExit | null {
  return useContext(WizardExitContext);
}
