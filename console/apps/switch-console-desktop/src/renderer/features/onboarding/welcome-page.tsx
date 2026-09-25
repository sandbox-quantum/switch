import { Cloud, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { SwitchConsoleAppIcon } from '@renderer/lib/switch-console-app-icon';
import { Button } from '@renderer/lib/ui/button';
import { StepPager } from '@renderer/lib/ui/step-pager';
import { cn } from '@renderer/utils/utils';

const TAGLINE = 'Agents that work alongside your team, in the chat apps you already use.';

/**
 * The first page of a fresh install: what Switch is, and where it should run.
 *
 * It takes the whole window. There is no sidebar behind it because there is
 * nothing for a sidebar to list — no servers, so no rooms, agents or sessions —
 * and a first impression made of empty containers says less about the app than
 * one question does.
 *
 * The two places are a list, not a choice. Only one of them can be had: Switch
 * Cloud has no endpoint to sign in to and no account to sign in with. A radio
 * group would announce itself as something to pick between and then answer
 * neither arrow key nor click, which is a worse page than an honest list of
 * two, one of them marked unavailable. Cloud stays on the page rather than
 * being left off it, because the question is "where should it run" and an
 * answer that exists but is not ready yet is part of that answer.
 *
 * So nothing here is a control except the button, and the button says which of
 * the two it takes — the emphasis on the card is a repeat of that in colour,
 * not the only place it is written.
 */
export function WelcomePage({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex h-full flex-col bg-background text-foreground [-webkit-app-region:drag]">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {/* Everything the page shows opts out of the drag region: a scroll
            inside one is swallowed by the window move. What stays draggable is
            the margin around it. */}
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-8 px-8 py-10 [-webkit-app-region:no-drag]">
          <div className="flex flex-col items-center gap-4">
            <SwitchConsoleAppIcon size={64} className="rounded-2xl" />
            <h1 className="text-3xl font-semibold">Welcome to Switch</h1>
            <p className="text-center text-sm text-foreground-muted">{TAGLINE}</p>
          </div>

          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Where should it run?</h2>
            <ul className="grid gap-3">
              <HostingChoice
                icon={<Cloud className="size-5" />}
                title="Switch Cloud"
                badge="Coming soon"
                description="We would run it for you. Not open yet — there is nothing to sign in to."
                unavailable
              />
              <HostingChoice
                icon={<Server className="size-5" />}
                title="Your own server"
                description="Run the Switch stack on hardware you control. Your data and your accounts stay there."
              />
            </ul>
            <div className="mt-1">
              <Button onClick={onContinue}>Continue with your own server</Button>
            </div>
          </div>
        </div>
      </div>
      <div className="[-webkit-app-region:no-drag]">
        <StepPager pageName="Welcome" onBack={null} onNext={onContinue} />
      </div>
    </div>
  );
}

function HostingChoice({
  icon,
  title,
  badge,
  description,
  unavailable = false,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  description: string;
  /** Somewhere Switch cannot run yet. Said in the badge and the description
   * too, so it does not rest on the greyed-out card alone. */
  unavailable?: boolean;
}) {
  return (
    <li
      className={cn(
        'flex list-none items-start gap-3 rounded-lg border p-4 text-left',
        unavailable ? 'border-border opacity-60' : 'border-foreground'
      )}
    >
      <span className="mt-0.5 text-foreground-muted">{icon}</span>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge && (
            <span className="rounded-full bg-background-tertiary-2 px-2 py-0.5 text-[10px] text-foreground-muted">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-foreground-muted">{description}</p>
      </div>
    </li>
  );
}
