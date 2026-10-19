import { MessagesSquare, ShieldCheck, Users } from 'lucide-react';
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
      footer={<Button onClick={onContinue}>Get started</Button>}
    >
      <div className="flex flex-col items-center gap-10">
        <SwitchConsoleAppIcon size={96} className="rounded-3xl" />
        <h1 className="text-center text-3xl font-semibold">
          Your teams, your agents, all in the same room
        </h1>
        <ul className="grid w-full gap-8 sm:grid-cols-3">
          <Point icon={<MessagesSquare className="size-5" />} title="In your chat app">
            Bring your agents from any provider to your messaging apps and start working together.
          </Point>
          <Point icon={<Users className="size-5" />} title="Shared knowledge">
            Chat history, instructions and documents available to every agent and person on the
            team.
          </Point>
          <Point icon={<ShieldCheck className="size-5" />} title="Security first">
            Built-in, customisable guardrails keep your data safe and your agents well-behaved.
          </Point>
        </ul>
        <UsageDataNotice />
      </div>
    </OnboardingSurface>
  );
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex list-none flex-col items-center gap-2 text-center">
      <span className="text-foreground-muted">{icon}</span>
      <span className="text-sm font-medium text-foreground">{title}</span>
      <p className="text-sm text-foreground-muted">{children}</p>
    </li>
  );
}
