import { createContext, useContext, type ReactNode } from 'react';
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

export function WizardChromeProvider({
  chrome,
  children,
}: {
  chrome: WizardChrome;
  children: ReactNode;
}) {
  return <WizardChromeContext.Provider value={chrome}>{children}</WizardChromeContext.Provider>;
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
    <div className="flex h-full flex-col bg-background text-foreground [-webkit-app-region:drag]">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-8 py-10 [-webkit-app-region:no-drag]">
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {subtitle && <p className="text-sm text-foreground-muted">{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="flex gap-2">{footer}</div>}
        </div>
      </div>
      {pager && (
        <div className="[-webkit-app-region:no-drag]">
          <StepPager {...pager} />
        </div>
      )}
    </div>
  );
}
