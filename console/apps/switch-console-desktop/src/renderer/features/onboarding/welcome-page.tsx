import { Cloud, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { SwitchConsoleAppIcon } from '@renderer/lib/switch-console-app-icon';
import { Button } from '@renderer/lib/ui/button';
import { Spinner } from '@renderer/lib/ui/spinner';
import { StepPager } from '@renderer/lib/ui/step-pager';
import { cn } from '@renderer/utils/utils';

const TAGLINE = 'Agents that work alongside your team, in the chat apps you already use.';

/**
 * What the welcome page can say about Switch Cloud, and what choosing it does.
 *
 * `connecting` and `error` belong to the attempt, not to the configuration: the
 * page stays up while the server is registered, and a failure is shown on the
 * card that was chosen rather than somewhere the eye has already left.
 */
export type WelcomeCloud =
  | { kind: 'reading' }
  | { kind: 'closed' }
  | { kind: 'failed'; headline: string; detail: string | null }
  | {
      kind: 'open';
      url: string;
      connecting: boolean;
      error: string | null;
      onConnect: () => void;
    };

/**
 * The first page of a fresh install: what Switch is, and where it should run.
 *
 * It takes the whole window. There is no sidebar behind it because there is
 * nothing for a sidebar to list — no servers, so no rooms, agents or sessions —
 * and a first impression made of empty containers says less about the app than
 * one question does.
 *
 * Switch Cloud is on the page only when this build has been told where it is;
 * otherwise your own server is the one place listed. A build whose Cloud
 * configuration could not be read still shows the card, marked unavailable in
 * words as well as in grey, since that is a broken build to fix. A radio group
 * would announce itself as something to pick between and then answer neither
 * arrow key nor click.
 *
 * Either way the controls are buttons that say which place they take, and the
 * emphasis on a card is a repeat of that in colour, not the only place it is
 * written. With two places open the pager has no Next: which one is next is the
 * question the page is asking.
 */
export function WelcomePage({
  cloud,
  onContinue,
  onInvite,
  onLeave,
}: {
  cloud: WelcomeCloud;
  onContinue: () => void;
  /** Join a workspace someone else set up, from the link they sent. */
  onInvite: () => void;
  /** Back to the app, when the pages were opened again rather than on a fresh install. */
  onLeave: (() => void) | null;
}) {
  const cloudOpen = cloud.kind === 'open';
  return (
    <div className="flex h-full flex-col bg-background text-foreground [-webkit-app-region:drag]">
      {onLeave && (
        <div className="flex justify-end px-4 pt-3 [-webkit-app-region:no-drag]">
          <Button variant="ghost" size="sm" onClick={onLeave}>
            Back to the app
          </Button>
        </div>
      )}
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
              <CloudChoice cloud={cloud} />
              <HostingChoice
                icon={<Server className="size-5" />}
                title="Your own server"
                description="Run the Switch stack on hardware you control. Your data and your accounts stay there."
                emphasised={!cloudOpen}
              />
            </ul>
            <div className="mt-1 flex flex-wrap gap-2">
              {cloudOpen && (
                <Button onClick={cloud.onConnect} disabled={cloud.connecting}>
                  {cloud.connecting && <Spinner className="size-3.5" />}
                  Continue with Switch Cloud
                </Button>
              )}
              <Button
                variant={cloudOpen ? 'outline' : 'default'}
                onClick={onContinue}
                disabled={cloudOpen && cloud.connecting}
              >
                Continue with your own server
              </Button>
            </div>
            <p className="text-xs text-foreground-muted">
              Invited to a workspace?{' '}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 disabled:opacity-50"
                onClick={onInvite}
                disabled={cloudOpen && cloud.connecting}
              >
                Paste your invite link
              </button>
            </p>
          </div>
        </div>
      </div>
      <div className="[-webkit-app-region:no-drag]">
        <StepPager pageName="Welcome" onBack={null} onNext={cloudOpen ? null : onContinue} />
      </div>
    </div>
  );
}

function CloudChoice({ cloud }: { cloud: WelcomeCloud }) {
  const icon = <Cloud className="size-5" />;
  switch (cloud.kind) {
    case 'open':
      return (
        <HostingChoice
          icon={icon}
          title="Switch Cloud"
          description={`We run it for you at ${new URL(cloud.url).host}. Sign in, or create an account there.`}
          emphasised
          error={cloud.error}
        />
      );
    case 'failed':
      return (
        <HostingChoice
          icon={icon}
          title="Switch Cloud"
          badge="Unavailable"
          description={`${cloud.headline}${cloud.detail ? ` ${cloud.detail}` : ''}`}
          unavailable
        />
      );
    // A build that cannot reach the Cloud does not mention it: stable ships
    // the code before the Cloud is open to it, and a card for somewhere you
    // cannot go is a promise the build has no way to keep.
    case 'reading':
    case 'closed':
      return null;
  }
}

function HostingChoice({
  icon,
  title,
  badge,
  description,
  unavailable = false,
  emphasised = false,
  error = null,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  description: string;
  /** The place the primary button takes. */
  emphasised?: boolean;
  /** Why choosing this place just failed. */
  error?: string | null;
  /** Somewhere Switch cannot run yet. Said in the badge and the description
   * too, so it does not rest on the greyed-out card alone. */
  unavailable?: boolean;
}) {
  return (
    <li
      className={cn(
        'flex list-none items-start gap-3 rounded-lg border p-4 text-left',
        unavailable && 'opacity-60',
        emphasised ? 'border-foreground' : 'border-border'
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
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}
